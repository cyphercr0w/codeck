import { Command } from 'commander';
import chalk from 'chalk';
import * as p from '@clack/prompts';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { getConfig, setConfig, isInitialized, type CodeckMode } from '../lib/config.js';
import { composeUp } from '../lib/docker.js';

export const startCommand = new Command('start')
  .description('Start the Codeck container(s)')
  .option('--mode <mode>', 'Override mode: isolated or managed')
  .action(async (opts) => {
    if (!isInitialized()) {
      console.log(chalk.red('Codeck not initialized. Run `codeck init` first.'));
      process.exit(1);
    }

    const config = getConfig();
    const mode: CodeckMode = opts.mode === 'isolated' || opts.mode === 'managed' ? opts.mode : config.mode;

    if (opts.mode && opts.mode !== 'isolated' && opts.mode !== 'managed') {
      console.log(chalk.red('Invalid mode. Use "isolated" or "managed".'));
      process.exit(1);
    }

    try {
      console.log(chalk.dim(`Starting in ${mode} mode...`));

      // In managed mode, create a shared data directory on the host
      // so daemon and runtime container share auth.json, sessions, etc.
      let sharedDataDir: string | undefined;
      if (mode === 'managed') {
        sharedDataDir = join(config.projectPath, '.codeck-data');
        if (!existsSync(sharedDataDir)) {
          mkdirSync(sharedDataDir, { recursive: true });
        }
      }

      // In managed mode, generate a shared secret so daemon proxy ↔ runtime
      // can authenticate internal requests without user tokens.
      const internalSecret = mode === 'managed' ? randomBytes(32).toString('hex') : undefined;

      // Start the runtime container
      await composeUp({
        projectPath: config.projectPath,
        lanMode: config.lanMode,
        mode,
        build: mode === 'managed',
        env: sharedDataDir ? {
          // Pass to compose so the bind-mount resolves to the host path
          CODECK_DATA_DIR: sharedDataDir,
          ...(internalSecret ? { CODECK_INTERNAL_SECRET: internalSecret } : {}),
        } : undefined,
      });

      if (mode === 'managed') {
        // In managed mode, run the daemon in foreground
        console.log(chalk.dim('Runtime container started.'));

        // Offer LAN access on Windows/macOS (Linux uses host networking)
        let lanStarted = false;
        if (process.platform !== 'linux') {
          const lanResult = await p.confirm({
            message: 'Enable LAN access? (codeck.local)',
            initialValue: true,
          });

          if (!p.isCancel(lanResult) && lanResult) {
            const scriptPath = join(config.projectPath, 'scripts', 'mdns-advertiser.cjs');
            const scriptsDir = join(config.projectPath, 'scripts');
            const portArg = String(config.port);

            // Install script deps if needed
            if (!existsSync(join(scriptsDir, 'node_modules'))) {
              console.log(chalk.dim('Installing mDNS dependencies...'));
              const { execa: ex } = await import('execa');
              await ex('npm', ['install'], { cwd: scriptsDir, stdio: 'inherit' });
            }

            if (process.platform === 'win32') {
              try {
                const { execa: ex } = await import('execa');
                const { stdout } = await ex('powershell', [
                  '-NoProfile', '-Command',
                  `$p = Start-Process -FilePath '${process.execPath}' ` +
                  `-ArgumentList '"${scriptPath}" ${portArg}' ` +
                  `-Verb RunAs -WindowStyle Hidden -PassThru; ` +
                  `Write-Output $p.Id`,
                ]);
                const pid = parseInt(stdout.trim(), 10);
                if (!isNaN(pid) && pid > 0) {
                  setConfig({ lanPid: pid });
                  lanStarted = true;
                }
              } catch {
                console.log(chalk.yellow('UAC denied — LAN access skipped.'));
              }
            } else {
              // macOS
              const child = spawn(process.execPath, [scriptPath, portArg], {
                cwd: scriptsDir,
                detached: true,
                stdio: 'ignore',
              });
              child.unref();
              if (child.pid) {
                setConfig({ lanPid: child.pid });
                lanStarted = true;
              }
            }

            if (lanStarted) {
              console.log(chalk.green('LAN access enabled (codeck.local).'));
            }
          }
        }

        console.log(chalk.dim('Starting daemon...'));
        console.log();

        const { execa } = await import('execa');
        const daemonPath = join(config.projectPath, 'apps/daemon/dist/index.js');

        const daemonProcess = execa('node', [daemonPath], {
          cwd: config.projectPath,
          stdio: 'inherit',
          env: {
            ...process.env,
            CODECK_DAEMON_PORT: String(config.port),
            CODECK_RUNTIME_URL: 'http://127.0.0.1:7777',
            CODECK_RUNTIME_WS_URL: 'http://127.0.0.1:7778',
            CODECK_PROJECT_DIR: config.projectPath,
            CODECK_COMPOSE_FILE: 'docker/compose.managed.yml',
            // Daemon reads auth.json from the shared data dir
            CODECK_DIR: sharedDataDir!,
            // Shared secret for daemon ↔ runtime internal auth
            CODECK_INTERNAL_SECRET: internalSecret!,
            NODE_ENV: 'production',
          },
        });

        // On SIGINT/SIGTERM, stop daemon + mDNS + container
        const cleanup = async (signal: string) => {
          console.log(chalk.dim(`\nReceived ${signal}, stopping...`));
          daemonProcess.kill(signal === 'SIGTERM' ? 'SIGTERM' : 'SIGINT');
          try {
            await daemonProcess;
          } catch { /* process exited */ }

          // Stop mDNS advertiser if we started it
          if (lanStarted) {
            const lanPid = getConfig().lanPid;
            if (lanPid) {
              try {
                if (process.platform === 'win32') {
                  execFileSync('taskkill', ['/PID', String(lanPid), '/F', '/T'], { stdio: 'ignore' });
                } else {
                  process.kill(lanPid, 'SIGTERM');
                }
              } catch { /* best effort */ }
              setConfig({ lanPid: undefined });
            }
          }

          console.log(chalk.dim('Stopping runtime container...'));
          const { composeDown } = await import('../lib/docker.js');
          try {
            await composeDown({ projectPath: config.projectPath, mode });
          } catch { /* best effort */ }
          console.log(chalk.green('Codeck stopped.'));
          process.exit(0);
        };

        process.on('SIGINT', () => cleanup('SIGINT'));
        process.on('SIGTERM', () => cleanup('SIGTERM'));

        // Wait for daemon to exit
        try {
          await daemonProcess;
        } catch (e) {
          console.log(chalk.red(`Daemon exited: ${(e as Error).message}`));
        }
      } else {
        console.log();
        console.log(chalk.green('Codeck is running!'));
        console.log(chalk.dim(`  Mode: ${mode}`));
        console.log(chalk.dim(`  URL:  http://localhost${config.port === 80 ? '' : ':' + config.port}`));
        if (config.lanMode === 'host') {
          console.log(chalk.dim('  LAN:  http://codeck.local'));
        } else if (config.lanMode === 'mdns') {
          console.log(chalk.dim('  LAN:  Run `codeck lan start` for mDNS access'));
        }
        console.log();
      }
    } catch (err) {
      console.log(chalk.red(`Failed to start: ${(err as Error).message}`));
      process.exit(1);
    }
  });
