import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { execa } from 'execa';
import { getConfig, setConfig, deleteLanPid, isInitialized } from '../lib/config.js';
import { detectOS } from '../lib/detect.js';

const HEARTBEAT_PATH = join(tmpdir(), 'codeck-mdns.heartbeat');
const HEARTBEAT_STALE_MS = 60_000; // consider heartbeat stale after 60s

const HOSTS_PATH = process.platform === 'win32'
  ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
  : '/etc/hosts';
const HOSTS_MARKER_START = '# codeck-ports-start';
const HOSTS_MARKER_END = '# codeck-ports-end';

/** Remove codeck entries from the hosts file. Elevates on Windows if needed. */
async function cleanupHostsFile(): Promise<void> {
  if (process.platform === 'win32') {
    // Write cleanup script to a temp file to avoid PowerShell quoting nightmares
    const scriptPath = join(tmpdir(), 'codeck-hosts-cleanup.ps1');
    writeFileSync(scriptPath, [
      `$hostsPath = '${HOSTS_PATH.replace(/\\/g, '\\\\')}'`,
      `$start = '${HOSTS_MARKER_START}'`,
      `$end = '${HOSTS_MARKER_END}'`,
      `$h = [IO.File]::ReadAllText($hostsPath)`,
      `$si = $h.IndexOf($start)`,
      `$ei = $h.IndexOf($end)`,
      `if ($si -ge 0 -and $ei -ge 0) {`,
      `  $cleaned = $h.Substring(0, $si) + $h.Substring($ei + $end.Length)`,
      `  $cleaned = [regex]::Replace($cleaned, '\`n{3,}', '\`n\`n')`,
      `  [IO.File]::WriteAllText($hostsPath, $cleaned)`,
      `}`,
    ].join('\n'), 'utf-8');

    try {
      await execa('powershell', [
        '-NoProfile', '-Command',
        `Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"' -Verb RunAs -WindowStyle Hidden -Wait`,
      ]);
      console.log(chalk.dim('Cleaned up hosts file entries.'));
    } catch {
      console.log(chalk.yellow('UAC denied — could not clean hosts file. Remove codeck.local entries manually.'));
    }
  } else {
    try {
      const content = readFileSync(HOSTS_PATH, 'utf-8');
      const startIdx = content.indexOf(HOSTS_MARKER_START);
      const endIdx = content.indexOf(HOSTS_MARKER_END);
      if (startIdx !== -1 && endIdx !== -1) {
        const newContent = content.substring(0, startIdx) +
          content.substring(endIdx + HOSTS_MARKER_END.length);
        writeFileSync(HOSTS_PATH, newContent.replace(/\n{3,}/g, '\n\n'), 'utf-8');
        console.log(chalk.dim('Cleaned up hosts file entries.'));
      }
    } catch {
      console.log(chalk.yellow('Could not clean hosts file — try with sudo.'));
    }
  }
}

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

    const portArg = String(config.port);

    if (process.platform === 'win32') {
      // On Windows, elevate via UAC prompt so the advertiser can write the hosts file
      try {
        const { stdout } = await execa('powershell', [
          '-NoProfile', '-Command',
          // Start-Process -Verb RunAs triggers the UAC yes/no dialog
          `$p = Start-Process -FilePath '${process.execPath}' ` +
          `-ArgumentList '"${scriptPath}" ${portArg}' ` +
          `-Verb RunAs -WindowStyle Hidden -PassThru; ` +
          `Write-Output $p.Id`,
        ]);
        const pid = parseInt(stdout.trim(), 10);
        if (!isNaN(pid) && pid > 0) {
          setConfig({ lanPid: pid });
          console.log(chalk.green(`mDNS advertiser started as admin (PID ${pid}).`));
          console.log(chalk.dim('  codeck.local and {port}.codeck.local now resolve on LAN.'));
        } else {
          console.log(chalk.red('Failed to get advertiser PID.'));
        }
      } catch {
        console.log(chalk.red('UAC elevation was denied or failed.'));
        console.log(chalk.dim('You can also run `codeck lan start` from an admin terminal.'));
      }
    } else {
      // macOS/Linux: spawn detached, pass port as argv
      const child = spawn(process.execPath, [scriptPath, portArg], {
        cwd: scriptsDir,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          CODECK_DAEMON_PORT: portArg,
        },
      });
      child.unref();

      if (child.pid) {
        setConfig({ lanPid: child.pid });
        console.log(chalk.green(`mDNS advertiser started (PID ${child.pid}).`));
        console.log(chalk.dim('  codeck.local and {port}.codeck.local now resolve on LAN.'));
      }
    }
  });

lanCommand
  .command('stop')
  .description('Stop mDNS advertiser')
  .action(async () => {
    const config = getConfig();

    // Always clean hosts file (process may have died without cleanup)
    await cleanupHostsFile();

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
        // Use /F (force) — elevated processes need it. Elevate if needed.
        try {
          execFileSync('taskkill', ['/PID', String(config.lanPid), '/F', '/T'], { stdio: 'ignore' });
        } catch {
          // Non-elevated terminal can't kill elevated process — try via PowerShell elevation
          await execa('powershell', [
            '-NoProfile', '-Command',
            `Start-Process -FilePath 'taskkill' -ArgumentList '/PID ${config.lanPid} /F /T' -Verb RunAs -WindowStyle Hidden -Wait`,
          ]);
        }
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
