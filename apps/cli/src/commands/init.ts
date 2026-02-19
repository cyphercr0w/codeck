import { Command } from 'commander';
import chalk from 'chalk';
import * as p from '@clack/prompts';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { getConfig, setConfig, isInitialized, type CodeckMode } from '../lib/config.js';
import { detectOS, isDockerInstalled, isDockerRunning, isPortAvailable, isBaseImageBuilt } from '../lib/detect.js';
import { generateOverrideYaml, generateEnvFile, writeOverrideFile, writeEnvFile, readEnvFile } from '../lib/compose.js';
import { buildBaseImage, composeUp } from '../lib/docker.js';

export const initCommand = new Command('init')
  .description('Interactive setup wizard for Codeck')
  .option('--rebuild-base', 'Force rebuild the base Docker image')
  .action(async (opts) => {
    p.intro(chalk.bold('Codeck Setup'));

    const existingConfig = isInitialized() ? getConfig() : null;
    if (existingConfig) {
      p.log.info('Existing configuration found. Values will be used as defaults.');
    }

    // 1. Detect OS + Docker availability (silently, no exit yet)
    const os = detectOS();
    p.log.info(`Detected OS: ${chalk.cyan(os)}`);

    const [dockerInstalled, dockerRunning] = await Promise.all([
      isDockerInstalled(),
      isDockerRunning(),
    ]);

    // 2. Mode selection
    type DeployMode = 'docker' | 'systemd';
    let mode: DeployMode;

    if (os === 'linux') {
      const modeResult = await p.select({
        message: 'Deployment mode:',
        options: [
          { value: 'systemd', label: 'systemd service', hint: 'VPS / bare Linux — recommended' },
          {
            value: 'docker',
            label: 'Docker',
            hint: dockerInstalled ? (dockerRunning ? 'running' : 'installed, not running') : 'not detected',
          },
        ],
        initialValue: (existingConfig as any)?.mode === 'docker' ? 'docker' : 'systemd',
      });
      if (p.isCancel(modeResult)) {
        p.outro(chalk.red('Setup cancelled.'));
        process.exit(0);
      }
      mode = modeResult as DeployMode;
    } else {
      // macOS / Windows — Docker is the only supported mode
      p.log.info(`On ${os}, Docker is the only supported deployment mode.`);
      if (!dockerInstalled) {
        p.log.warn(
          'Docker Desktop is not installed.\n' +
          '  Download it from https://www.docker.com/products/docker-desktop and try again.'
        );
      } else if (!dockerRunning) {
        p.log.warn('Docker Desktop is installed but not running. Start it and try again.');
      }
      mode = 'docker';
    }

    // systemd path — warn about isolation, print install command and exit
    if (mode === 'systemd') {
      p.log.warn(
        'systemd mode runs without container isolation.\n' +
        '  The agent has full access to the host filesystem and can run arbitrary commands.\n' +
        '  Use a dedicated machine or VPS — not your personal workstation.'
      );
      console.log();
      p.log.info('Run the installer on your Linux VPS as root:');
      console.log();
      console.log(chalk.cyan('  curl -fsSL https://raw.githubusercontent.com/cyphercr0w/codeck/main/scripts/install.sh | sudo bash'));
      console.log();
      p.outro(chalk.green('That\'s it — the script handles everything.'));
      process.exit(0);
    }

    // Docker mode — verify Docker is actually available now
    if (!dockerInstalled) {
      p.log.error('Docker is not installed. Please install Docker and try again.');
      p.outro(chalk.red('Setup aborted.'));
      process.exit(1);
    }
    if (!dockerRunning) {
      p.log.error('Docker is not running. Please start Docker and try again.');
      p.outro(chalk.red('Setup aborted.'));
      process.exit(1);
    }

    // 2.5 Codeck mode selection (local vs gateway)
    const defaultMode: CodeckMode = existingConfig?.mode || 'local';
    const codeckModeResult = await p.select({
      message: 'Codeck mode:',
      options: [
        { value: 'local', label: 'Local', hint: 'Single container — runtime serves the webapp directly' },
        { value: 'gateway', label: 'Gateway', hint: 'Daemon + runtime — daemon as public entry point, runtime isolated' },
      ],
      initialValue: defaultMode,
    });
    if (p.isCancel(codeckModeResult)) {
      p.outro(chalk.red('Setup cancelled.'));
      process.exit(0);
    }
    const codeckMode = codeckModeResult as CodeckMode;

    if (codeckMode === 'gateway') {
      p.log.info('Gateway mode: daemon handles auth and proxies to an isolated runtime.');
    }

    // 3. Detect project path
    let projectPath = existingConfig?.projectPath || '';
    const cwdHasCompose = existsSync(join(process.cwd(), 'docker-compose.yml')) &&
                          existsSync(join(process.cwd(), 'Dockerfile.base'));

    // Validate existing projectPath still exists
    if (projectPath && !existsSync(join(projectPath, 'docker-compose.yml'))) {
      projectPath = '';
    }

    if (cwdHasCompose) {
      projectPath = process.cwd();
      p.log.info(`Project found at: ${chalk.cyan(projectPath)}`);
    } else if (!projectPath) {
      const pathResult = await p.text({
        message: 'Path to the Codeck project directory:',
        placeholder: '/path/to/codeck',
        validate: (value) => {
          const resolved = resolve(value);
          if (!existsSync(join(resolved, 'docker-compose.yml'))) {
            return 'docker-compose.yml not found in that directory';
          }
          if (!existsSync(join(resolved, 'Dockerfile.base'))) {
            return 'Dockerfile.base not found in that directory';
          }
          return undefined;
        },
      });
      if (p.isCancel(pathResult)) {
        p.outro(chalk.red('Setup cancelled.'));
        process.exit(0);
      }
      projectPath = resolve(pathResult);
    }

    // Read existing .env for defaults
    const existingEnv = readEnvFile(projectPath);

    // 4. Webapp port
    const modeDefaultPort = codeckMode === 'gateway' ? 8080 : 80;
    const defaultPort = existingConfig?.port || parseInt(existingEnv.CODECK_PORT || String(modeDefaultPort), 10);
    const portResult = await p.text({
      message: codeckMode === 'gateway' ? 'Daemon port:' : 'Webapp port:',
      placeholder: String(defaultPort),
      defaultValue: String(defaultPort),
      validate: (value) => {
        const n = parseInt(value, 10);
        if (isNaN(n) || n < 1 || n > 65535) return 'Port must be 1-65535';
        return undefined;
      },
    });
    if (p.isCancel(portResult)) {
      p.outro(chalk.red('Setup cancelled.'));
      process.exit(0);
    }
    const port = parseInt(portResult, 10);

    // Check port availability — block if in use
    const portFree = await isPortAvailable(port);
    if (!portFree) {
      p.log.error(`Port ${port} is already in use.`);
      const continueAnyway = await p.confirm({
        message: 'Continue anyway? (container will fail to start if the port is not freed)',
        initialValue: false,
      });
      if (p.isCancel(continueAnyway) || !continueAnyway) {
        p.outro(chalk.red('Setup cancelled. Free the port and try again.'));
        process.exit(1);
      }
    }

    // 5. Extra ports (local mode only — gateway runtime is isolated)
    let extraPorts: number[] = [];
    if (codeckMode === 'local') {
      const defaultExtraPorts = existingConfig?.extraPorts || [];
      const portsResult = await p.multiselect({
        message: 'Pre-map extra ports for dev server preview:',
        options: [
          { value: 3000, label: '3000 (React/Next.js)', hint: defaultExtraPorts.includes(3000) ? 'previously selected' : '' },
          { value: 5173, label: '5173 (Vite)', hint: defaultExtraPorts.includes(5173) ? 'previously selected' : '' },
          { value: 8080, label: '8080 (Generic)', hint: defaultExtraPorts.includes(8080) ? 'previously selected' : '' },
          { value: -1, label: 'Custom port...' },
        ],
        initialValues: defaultExtraPorts.length > 0
          ? defaultExtraPorts.filter(n => [3000, 5173, 8080].includes(n))
          : [],
        required: false,
      });
      if (p.isCancel(portsResult)) {
        p.outro(chalk.red('Setup cancelled.'));
        process.exit(0);
      }

      extraPorts = (portsResult as number[]).filter(n => n > 0);

      // Handle custom port
      if ((portsResult as number[]).includes(-1)) {
        const customResult = await p.text({
          message: 'Enter custom port(s), comma-separated:',
          placeholder: '4000, 9090',
          validate: (value) => {
            const nums = value.split(',').map(s => parseInt(s.trim(), 10));
            if (nums.some(n => isNaN(n) || n < 1 || n > 65535)) {
              return 'Invalid port number';
            }
            return undefined;
          },
        });
        if (!p.isCancel(customResult)) {
          const custom = customResult.split(',').map(s => parseInt(s.trim(), 10));
          extraPorts = [...extraPorts, ...custom];
        }
      }

      // Remove duplicates
      extraPorts = [...new Set(extraPorts)].sort((a, b) => a - b);
    }

    // 6. LAN mode (local mode only — gateway uses its own network config)
    let lanMode: 'none' | 'host' | 'mdns' = existingConfig?.lanMode || 'none';
    if (codeckMode === 'local') {
      if (os === 'linux') {
        const lanResult = await p.select({
          message: 'LAN access mode:',
          options: [
            { value: 'none', label: 'None', hint: 'Localhost only' },
            { value: 'host', label: 'Host networking', hint: 'codeck.local via avahi (Linux only)' },
          ],
          initialValue: lanMode === 'host' ? 'host' : 'none',
        });
        if (p.isCancel(lanResult)) {
          p.outro(chalk.red('Setup cancelled.'));
          process.exit(0);
        }
        lanMode = lanResult as 'none' | 'host';
      } else {
        const lanResult = await p.select({
          message: 'LAN access mode:',
          options: [
            { value: 'none', label: 'None', hint: 'Localhost only' },
            { value: 'mdns', label: 'mDNS advertiser', hint: 'codeck.local via Bonjour (requires admin)' },
          ],
          initialValue: lanMode === 'mdns' ? 'mdns' : 'none',
        });
        if (p.isCancel(lanResult)) {
          p.outro(chalk.red('Setup cancelled.'));
          process.exit(0);
        }
        lanMode = lanResult as 'none' | 'mdns';
      }
    } else {
      lanMode = 'none';
    }

    // 7. GitHub Token
    const defaultGhToken = existingEnv.GITHUB_TOKEN || '';
    const ghResult = await p.password({
      message: 'GitHub token (optional, press Enter to skip):',
    });
    const ghToken = p.isCancel(ghResult) ? defaultGhToken : (ghResult || defaultGhToken);

    // 8. Anthropic API Key
    const defaultApiKey = existingEnv.ANTHROPIC_API_KEY || '';
    const apiKeyResult = await p.password({
      message: 'Anthropic API key (optional, press Enter to skip):',
    });
    const apiKey = p.isCancel(apiKeyResult) ? defaultApiKey : (apiKeyResult || defaultApiKey);

    // 9. Generate files
    const s = p.spinner();
    s.start('Generating configuration files...');

    // Track files created by this init for cleanup on failure
    const envPath = join(projectPath, '.env');
    const overridePath = join(projectPath, 'docker-compose.override.yml');
    const envExistedBefore = existsSync(envPath);
    const overrideExistedBefore = existsSync(overridePath);

    const envVars: Record<string, string> = {};
    if (codeckMode === 'gateway') {
      envVars.CODECK_DAEMON_PORT = String(port);
    } else {
      envVars.CODECK_PORT = String(port);
    }
    if (ghToken) envVars.GITHUB_TOKEN = ghToken;
    if (apiKey) envVars.ANTHROPIC_API_KEY = apiKey;

    writeEnvFile(projectPath, generateEnvFile(envVars));

    const overrideContent = extraPorts.length > 0
      ? generateOverrideYaml(extraPorts, port)
      : '';

    if (overrideContent) {
      writeOverrideFile(projectPath, overrideContent);
    } else {
      // Remove stale override from a previous init
      if (existsSync(overridePath)) {
        try { unlinkSync(overridePath); } catch { /* ignore */ }
      }
    }

    s.stop('Configuration files generated.');

    // Warn about secret storage if tokens were written
    if (ghToken || apiKey) {
      p.log.warn('Secrets are stored in plaintext in the .env file. Ensure .env is in .gitignore.');
    }

    // 10. Save config
    setConfig({
      projectPath,
      port,
      extraPorts,
      lanMode,
      mode: codeckMode,
      initialized: true,
      os,
    });

    // 11. Build base image if needed
    const baseBuilt = await isBaseImageBuilt();
    if (!baseBuilt || opts.rebuildBase) {
      const label = opts.rebuildBase ? 'Rebuilding base image...' : 'Building base image (first time, may take a few minutes)...';
      p.log.info(label);
      try {
        await buildBaseImage(projectPath);
        p.log.success('Base image built.');
      } catch (err) {
        // Clean up files created by this init run (not pre-existing ones)
        if (!envExistedBefore) {
          try { unlinkSync(envPath); } catch { /* ignore */ }
        }
        if (!overrideExistedBefore && existsSync(overridePath)) {
          try { unlinkSync(overridePath); } catch { /* ignore */ }
        }
        p.log.error(`Base image build failed: ${(err as Error).message}`);
        p.outro(chalk.red('Fix the build error and run `codeck init --rebuild-base`.'));
        process.exit(1);
      }
    } else {
      p.log.info('Base image already built.');
    }

    // 12. Start container
    const startResult = await p.confirm({
      message: 'Start Codeck now?',
      initialValue: true,
    });

    if (!p.isCancel(startResult) && startResult) {
      p.log.info('Starting Codeck...');
      try {
        await composeUp({
          projectPath,
          lanMode,
          mode: codeckMode,
        });
        const url = `http://localhost${port === 80 ? '' : ':' + port}`;
        p.log.success(`Codeck is running at ${chalk.cyan(url)}`);
      } catch (err) {
        p.log.error(`Failed to start: ${(err as Error).message}`);
        p.log.info('You can try again with `codeck start`.');
      }
    }

    // Done
    p.outro(chalk.green('Setup complete!'));
    console.log();
    console.log(chalk.dim('  Next steps:'));
    console.log(chalk.dim('    codeck open     — Open webapp in browser'));
    console.log(chalk.dim('    codeck status   — Check container status'));
    console.log(chalk.dim('    codeck logs     — Stream container logs'));
    console.log(chalk.dim('    codeck doctor   — Diagnose issues'));
    console.log();
  });
