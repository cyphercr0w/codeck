import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, isInitialized } from '../lib/config.js';
import { composeDown, composeUp } from '../lib/docker.js';
import { getContainerStatus } from '../lib/detect.js';

export const restartCommand = new Command('restart')
  .description('Restart the Codeck container(s)')
  .action(async () => {
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

      console.log(chalk.dim(`Starting in ${config.mode} mode...`));
      await composeUp({
        projectPath: config.projectPath,
        lanMode: config.lanMode,
        mode: config.mode,
        build: config.mode === 'managed',
      });

      console.log();
      console.log(chalk.green('Codeck restarted!'));
      console.log(chalk.dim(`  Mode: ${config.mode}`));
      console.log(chalk.dim(`  URL:  http://localhost${config.port === 80 ? '' : ':' + config.port}`));

      if (config.mode === 'managed') {
        console.log(chalk.dim('  Note: Restart the daemon process separately (Ctrl+C + codeck start).'));
      }

      console.log();
    } catch (err) {
      console.log(chalk.red(`Failed to restart: ${(err as Error).message}`));
      process.exit(1);
    }
  });
