import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, isInitialized } from '../lib/config.js';
import { composeDown, composeUp } from '../lib/docker.js';
import { getContainerStatus } from '../lib/detect.js';

export const restartCommand = new Command('restart')
  .description('Restart the Codeck container(s)')
  .option('--dev', 'Restart in development mode')
  .action(async (opts) => {
    if (!isInitialized()) {
      console.log(chalk.red('Codeck not initialized. Run `codeck init` first.'));
      process.exit(1);
    }

    const config = getConfig();

    try {
      console.log(chalk.dim('Stopping...'));
      await composeDown({
        projectPath: config.projectPath,
        lanMode: config.lanMode,
        mode: config.mode,
      });

      // Verify containers stopped before starting new ones
      let retries = 10;
      while (retries-- > 0) {
        const containers = await getContainerStatus(config.projectPath, config.mode);
        const running = containers.filter(c => c.state === 'running');
        if (running.length === 0) break;
        await new Promise(r => setTimeout(r, 1000));
      }

      const label = config.mode === 'gateway' ? 'gateway mode' : (opts.dev ? 'dev mode' : 'local mode');
      console.log(chalk.dim(`Starting in ${label}...`));
      await composeUp({
        projectPath: config.projectPath,
        lanMode: config.lanMode,
        mode: config.mode,
        dev: config.mode === 'local' ? opts.dev : false,
        build: config.mode === 'local' ? opts.dev : true,
      });

      console.log();
      console.log(chalk.green('Codeck restarted!'));
      console.log(chalk.dim(`  Mode: ${config.mode}`));
      console.log(chalk.dim(`  URL:  http://localhost${config.port === 80 ? '' : ':' + config.port}`));
      console.log();
    } catch (err) {
      console.log(chalk.red(`Failed to restart: ${(err as Error).message}`));
      process.exit(1);
    }
  });
