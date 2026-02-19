import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, isInitialized, getConfigPath } from '../lib/config.js';
import { getContainerStatus } from '../lib/detect.js';

export const statusCommand = new Command('status')
  .description('Show Codeck container status and configuration')
  .action(async () => {
    if (!isInitialized()) {
      console.log(chalk.red('Codeck not initialized. Run `codeck init` first.'));
      process.exit(1);
    }

    const config = getConfig();

    console.log(chalk.bold('\nCodeck Status\n'));

    // Config summary
    console.log(chalk.dim('Configuration'));
    console.log(`  Project:     ${config.projectPath}`);
    console.log(`  Mode:        ${config.mode}`);
    console.log(`  Port:        ${config.port}`);
    if (config.mode === 'local') {
      console.log(`  Extra ports: ${config.extraPorts.length > 0 ? config.extraPorts.join(', ') : 'none'}`);
      console.log(`  LAN mode:   ${config.lanMode}`);
    }
    console.log(`  OS:          ${config.os}`);
    console.log(`  Config:      ${getConfigPath()}`);

    // Container status
    console.log(chalk.dim('\nContainers'));
    const containers = await getContainerStatus(config.projectPath, config.mode);
    if (containers.length === 0) {
      console.log(chalk.yellow('  No containers running. Run `codeck start`.'));
    } else {
      for (const c of containers) {
        const stateColor = c.state === 'running' ? chalk.green : chalk.yellow;
        console.log(`  ${c.name}  ${stateColor(c.state)}  ${chalk.dim(c.status)}`);
        if (c.ports) {
          console.log(`    ${chalk.dim(c.ports)}`);
        }
      }
    }

    // URLs
    console.log(chalk.dim('\nURLs'));
    const isRunning = containers.some(c => c.state === 'running');
    if (isRunning) {
      console.log(`  Local: ${chalk.cyan(`http://localhost${config.port === 80 ? '' : ':' + config.port}`)}`);
      if (config.mode === 'local') {
        if (config.lanMode === 'host') {
          console.log(`  LAN:   ${chalk.cyan('http://codeck.local')}`);
        } else if (config.lanMode === 'mdns') {
          console.log(`  LAN:   ${chalk.dim('Run `codeck lan start` for mDNS access')}`);
        }
      }
    } else {
      console.log(chalk.dim('  Containers not running'));
    }
    console.log();
  });
