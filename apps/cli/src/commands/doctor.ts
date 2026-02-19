import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  detectOS,
  isDockerInstalled,
  isDockerRunning,
  getDockerComposeVersion,
  isPortAvailable,
  isBaseImageBuilt,
  getContainerStatus,
  isNodeVersionOk,
} from '../lib/detect.js';
import { getConfig, isInitialized } from '../lib/config.js';
import { envFileExists, overrideExists } from '../lib/compose.js';

function ok(label: string, detail?: string): void {
  const extra = detail ? ` ${chalk.dim(detail)}` : '';
  console.log(`  ${chalk.green('✓')} ${label}${extra}`);
}

function fail(label: string, detail?: string): void {
  const extra = detail ? ` ${chalk.dim(detail)}` : '';
  console.log(`  ${chalk.red('✗')} ${label}${extra}`);
}

function warn(label: string, detail?: string): void {
  const extra = detail ? ` ${chalk.dim(detail)}` : '';
  console.log(`  ${chalk.yellow('!')} ${label}${extra}`);
}

export const doctorCommand = new Command('doctor')
  .description('Check environment and diagnose issues')
  .action(async () => {
    console.log(chalk.bold('\nCodeck Doctor\n'));
    let issues = 0;

    // Node version
    console.log(chalk.dim('System'));
    if (isNodeVersionOk()) {
      ok('Node.js', `v${process.versions.node}`);
    } else {
      fail('Node.js >= 20 required', `v${process.versions.node}`);
      issues++;
    }

    // OS
    const os = detectOS();
    ok('OS', os);

    // Docker installed
    console.log(chalk.dim('\nDocker'));
    const dockerInstalled = await isDockerInstalled();
    if (dockerInstalled) {
      ok('Docker installed');
    } else {
      fail('Docker not found', 'Install Docker Desktop or Docker Engine');
      issues++;
    }

    // Docker running
    if (dockerInstalled) {
      const dockerRunning = await isDockerRunning();
      if (dockerRunning) {
        ok('Docker daemon running');
      } else {
        fail('Docker daemon not running', 'Start Docker Desktop or dockerd');
        issues++;
      }

      // Compose v2
      const composeVersion = await getDockerComposeVersion();
      if (composeVersion) {
        ok('Docker Compose', `v${composeVersion}`);
      } else {
        fail('Docker Compose v2 not found');
        issues++;
      }

      // Base image
      const baseBuilt = await isBaseImageBuilt();
      if (baseBuilt) {
        ok('Base image (codeck-base)');
      } else {
        warn('Base image not built', 'Run codeck init or docker build -t codeck-base -f Dockerfile.base .');
      }
    }

    // Config
    console.log(chalk.dim('\nConfiguration'));
    if (isInitialized()) {
      ok('CLI initialized');
      const config = getConfig();

      // Project path
      if (config.projectPath && existsSync(config.projectPath)) {
        ok('Project path', config.projectPath);
        ok('Mode', config.mode);

        // Docker compose file
        const composeFile = config.mode === 'managed'
          ? 'docker/compose.managed.yml'
          : 'docker/compose.isolated.yml';
        if (existsSync(join(config.projectPath, composeFile))) {
          ok(composeFile);
        } else {
          fail(`${composeFile} not found`);
          issues++;
        }

        // .env
        if (envFileExists(config.projectPath)) {
          ok('.env file');
        } else {
          warn('.env file not found', 'Run codeck init to generate');
        }

        // override
        if (config.extraPorts.length > 0) {
          if (overrideExists(config.projectPath)) {
            ok('docker/compose.override.yml');
          } else {
            warn('docker/compose.override.yml missing', 'Extra ports configured but override not generated');
          }
        }

        // Port
        const portFree = await isPortAvailable(config.port);
        if (portFree) {
          ok(`Port ${config.port} available`, '(may change before start)');
        } else {
          warn(`Port ${config.port} in use`, 'Container may be running, or another process is using it');
        }

        // Container status
        if (dockerInstalled) {
          console.log(chalk.dim('\nContainers'));
          const containers = await getContainerStatus(config.projectPath, config.mode);
          if (containers.length > 0) {
            for (const c of containers) {
              if (c.state === 'running') {
                ok(c.name, c.status);
              } else {
                warn(c.name, `${c.state} — ${c.status}`);
              }
            }
          } else {
            warn('No containers found', 'Run codeck start');
          }
        }
      } else {
        fail('Project path invalid or missing', config.projectPath || '(not set)');
        issues++;
      }
    } else {
      warn('CLI not initialized', 'Run codeck init');
    }

    // Summary
    console.log();
    if (issues === 0) {
      console.log(chalk.green('All checks passed!'));
    } else {
      console.log(chalk.red(`${issues} issue${issues > 1 ? 's' : ''} found.`));
    }
    console.log();
  });
