import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, isInitialized, type CodeckMode } from '../lib/config.js';
import { composeUp } from '../lib/docker.js';

export const startCommand = new Command('start')
  .description('Start the Codeck container(s)')
  .option('--dev', 'Start in development mode (build from source)')
  .option('--mode <mode>', 'Override mode: local or gateway')
  .action(async (opts) => {
    if (!isInitialized()) {
      console.log(chalk.red('Codeck not initialized. Run `codeck init` first.'));
      process.exit(1);
    }

    const config = getConfig();
    const mode: CodeckMode = opts.mode === 'local' || opts.mode === 'gateway' ? opts.mode : config.mode;

    if (opts.mode && opts.mode !== 'local' && opts.mode !== 'gateway') {
      console.log(chalk.red('Invalid mode. Use "local" or "gateway".'));
      process.exit(1);
    }

    try {
      const label = mode === 'gateway' ? 'gateway mode' : (opts.dev ? 'dev mode' : 'local mode');
      console.log(chalk.dim(`Starting in ${label}...`));
      await composeUp({
        projectPath: config.projectPath,
        lanMode: config.lanMode,
        mode,
        dev: mode === 'local' ? opts.dev : false,
        build: mode === 'local' ? opts.dev : true,
      });

      console.log();
      console.log(chalk.green('Codeck is running!'));
      console.log(chalk.dim(`  Mode: ${mode}`));
      console.log(chalk.dim(`  URL:  http://localhost${config.port === 80 ? '' : ':' + config.port}`));
      if (mode === 'local') {
        if (config.lanMode === 'host') {
          console.log(chalk.dim('  LAN:  http://codeck.local'));
        } else if (config.lanMode === 'mdns') {
          console.log(chalk.dim('  LAN:  Run `codeck lan start` for mDNS access'));
        }
      }
      console.log();
    } catch (err) {
      console.log(chalk.red(`Failed to start: ${(err as Error).message}`));
      process.exit(1);
    }
  });
