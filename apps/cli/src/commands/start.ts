import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'node:path';
import { getConfig, isInitialized, type CodeckMode } from '../lib/config.js';
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

      // Start the runtime container
      await composeUp({
        projectPath: config.projectPath,
        lanMode: config.lanMode,
        mode,
        build: mode === 'managed',
      });

      if (mode === 'managed') {
        // In managed mode, run the daemon in foreground
        console.log(chalk.dim('Runtime container started. Starting daemon...'));
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
            NODE_ENV: 'production',
          },
        });

        // On SIGINT/SIGTERM, stop daemon then container
        const cleanup = async (signal: string) => {
          console.log(chalk.dim(`\nReceived ${signal}, stopping...`));
          daemonProcess.kill(signal === 'SIGTERM' ? 'SIGTERM' : 'SIGINT');
          try {
            await daemonProcess;
          } catch { /* process exited */ }
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
