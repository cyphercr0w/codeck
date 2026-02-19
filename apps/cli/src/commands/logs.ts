import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, isInitialized } from '../lib/config.js';
import { composeLogs } from '../lib/docker.js';

export const logsCommand = new Command('logs')
  .description('Stream Codeck container logs')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .action(async (opts) => {
    if (!isInitialized()) {
      console.log(chalk.red('Codeck not initialized. Run `codeck init` first.'));
      process.exit(1);
    }

    const MAX_LINES = 10_000;
    const lines = parseInt(opts.lines, 10);
    if (isNaN(lines) || lines < 1 || lines > MAX_LINES) {
      console.log(chalk.red(`Invalid --lines value. Must be between 1 and ${MAX_LINES}.`));
      process.exit(1);
    }

    const config = getConfig();

    try {
      await composeLogs({
        projectPath: config.projectPath,
        lanMode: config.lanMode,
        mode: config.mode,
        lines,
      });
    } catch {
      // User likely pressed Ctrl+C — normal exit
    }
  });
