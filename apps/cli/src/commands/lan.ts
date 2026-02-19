import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { execa } from 'execa';
import { getConfig, setConfig, deleteLanPid, isInitialized } from '../lib/config.js';
import { detectOS } from '../lib/detect.js';

const HEARTBEAT_PATH = join(tmpdir(), 'codeck-mdns.heartbeat');
const HEARTBEAT_STALE_MS = 60_000; // consider heartbeat stale after 60s

/** Check if a PID belongs to a Node.js process (likely our mDNS advertiser). */
function isNodeProcess(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf-8' });
      return output.toLowerCase().includes('node.exe');
    } else {
      // On Unix, check /proc/{pid}/cmdline for 'node'
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      return cmdline.includes('node');
    }
  } catch {
    return false;
  }
}

export const lanCommand = new Command('lan')
  .description('Manage LAN access via mDNS (codeck.local)');

lanCommand
  .command('start')
  .description('Start mDNS advertiser for LAN access')
  .action(async () => {
    if (!isInitialized()) {
      console.log(chalk.red('Codeck not initialized. Run `codeck init` first.'));
      process.exit(1);
    }

    const os = detectOS();
    const config = getConfig();

    if (os === 'linux') {
      console.log(chalk.dim('On Linux, LAN access uses host networking.'));
      console.log(chalk.dim('Start with: codeck start (LAN mode is configured in codeck init)'));
      return;
    }

    const scriptPath = join(config.projectPath, 'scripts', 'mdns-advertiser.cjs');
    if (!existsSync(scriptPath)) {
      console.log(chalk.red('mDNS advertiser script not found.'));
      console.log(chalk.dim(`Expected at: ${scriptPath}`));
      return;
    }

    // Install script dependencies if needed
    const scriptsDir = join(config.projectPath, 'scripts');
    if (!existsSync(join(scriptsDir, 'node_modules'))) {
      console.log(chalk.dim('Installing mDNS dependencies...'));
      await execa('npm', ['install'], { cwd: scriptsDir, stdio: 'inherit' });
    }

    // Check if already running (validate it's actually a node process)
    if (config.lanPid) {
      try {
        process.kill(config.lanPid, 0);
        if (isNodeProcess(config.lanPid)) {
          console.log(chalk.yellow(`mDNS advertiser already running (PID ${config.lanPid}).`));
          return;
        }
        // PID exists but isn't a node process — stale/reused PID
        deleteLanPid();
      } catch {
        // Process not running, clean up stale PID
        deleteLanPid();
      }
    }

    console.log(chalk.dim('Starting mDNS advertiser...'));
    console.log(chalk.yellow('Note: Admin/sudo may be required for hosts file management.'));

    // Use child_process.spawn for reliable detached process
    const child = spawn(process.execPath, [scriptPath], {
      cwd: scriptsDir,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    if (child.pid) {
      setConfig({ lanPid: child.pid });
      console.log(chalk.green(`mDNS advertiser started (PID ${child.pid}).`));
      console.log(chalk.dim('  codeck.local and {port}.codeck.local now resolve on LAN.'));
    }
  });

lanCommand
  .command('stop')
  .description('Stop mDNS advertiser')
  .action(async () => {
    const config = getConfig();
    if (!config.lanPid) {
      console.log(chalk.dim('mDNS advertiser is not running.'));
      return;
    }

    // Validate PID belongs to a node process before killing
    if (!isNodeProcess(config.lanPid)) {
      console.log(chalk.dim('mDNS advertiser not found (PID reused or already stopped).'));
      deleteLanPid();
      return;
    }

    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(config.lanPid), '/T'], { stdio: 'ignore' });
      } else {
        process.kill(config.lanPid, 'SIGTERM');
      }
      console.log(chalk.green(`mDNS advertiser stopped (PID ${config.lanPid}).`));
    } catch {
      console.log(chalk.dim('mDNS advertiser was not running.'));
    }
    deleteLanPid();
  });

lanCommand
  .command('status')
  .description('Check mDNS advertiser status')
  .action(async () => {
    const config = getConfig();
    if (!config.lanPid) {
      console.log(chalk.dim('mDNS advertiser is not running.'));
      return;
    }

    try {
      process.kill(config.lanPid, 0);
      if (isNodeProcess(config.lanPid)) {
        console.log(chalk.green(`mDNS advertiser running (PID ${config.lanPid}).`));
        // Check heartbeat freshness
        try {
          const { mtimeMs } = statSync(HEARTBEAT_PATH);
          const ageMs = Date.now() - mtimeMs;
          if (ageMs > HEARTBEAT_STALE_MS) {
            console.log(chalk.yellow(`  Warning: heartbeat is ${Math.round(ageMs / 1000)}s old — advertiser may be unresponsive.`));
          }
        } catch {
          // No heartbeat file — older version of advertiser, skip check
        }
      } else {
        console.log(chalk.dim('mDNS advertiser is not running (PID reused by another process).'));
        deleteLanPid();
      }
    } catch {
      console.log(chalk.dim('mDNS advertiser is not running (stale PID).'));
      deleteLanPid();
    }
  });
