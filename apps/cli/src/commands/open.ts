import { Command } from 'commander';
import chalk from 'chalk';
import openUrl from 'open';
import { getConfig, isInitialized } from '../lib/config.js';
import { getContainerStatus } from '../lib/detect.js';

export const openCommand = new Command('open')
  .description('Open the Codeck webapp in your browser')
  .action(async () => {
    if (!isInitialized()) {
      console.log(chalk.red('Codeck not initialized. Run `codeck init` first.'));
      process.exit(1);
    }

    const config = getConfig();
    const containers = await getContainerStatus(config.projectPath);
    const isRunning = containers.some(c => c.state === 'running');

    if (!isRunning) {
      console.log(chalk.yellow('Codeck is not running. Start it with `codeck start`.'));
      process.exit(1);
    }

    const url = `http://localhost${config.port === 80 ? '' : ':' + config.port}`;
    try {
      new URL(url);
    } catch {
      console.log(chalk.red(`Invalid URL: ${url}. Check your port configuration.`));
      process.exit(1);
    }
    console.log(chalk.dim(`Opening ${url}...`));
    await openUrl(url);
  });
