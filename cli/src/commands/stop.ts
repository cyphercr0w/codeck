import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, isInitialized } from '../lib/config.js';
import { composeDown } from '../lib/docker.js';

export const stopCommand = new Command('stop')
  .description('Stop the Codeck container(s)')
  .action(async () => {
    if (!isInitialized()) {
      console.log(chalk.red('Codeck not initialized. Run `codeck init` first.'));
      process.exit(1);
    }

    const config = getConfig();

    try {
      console.log(chalk.dim('Stopping Codeck...'));
      await composeDown({
        projectPath: config.projectPath,
        lanMode: config.lanMode,
        mode: config.mode,
      });
      console.log(chalk.green('Codeck stopped.'));
    } catch (err) {
      console.log(chalk.red(`Failed to stop: ${(err as Error).message}`));
      process.exit(1);
    }
  });
