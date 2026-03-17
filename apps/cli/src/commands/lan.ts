import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { execa } from 'execa';
import { getConfig, setConfig, deleteLanPid, isInitialized } from '../lib/config.js';
import { detectOS } from '../lib/detect.js';

/** Validate port is an integer in the valid range. Returns the validated port number or throws. */
function validatePort(port: unknown): number {
  const num = Number(port);
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new Error(`Invalid port: ${String(port)}. Must be an integer between 1 and 65535.`);
  }
  return num;
}

/** Validate that a script path exists and is within the expected project directory. */
function validateScriptPath(scriptPath: string, projectPath: string): string {
  const resolvedScript = realpathSync(resolve(scriptPath));
  const resolvedProject = realpathSync(resolve(projectPath));
  if (!resolvedScript.startsWith(resolvedProject)) {
    throw new Error(`Script path escapes project directory: ${scriptPath}`);
  }
  return resolvedScript;
}

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
      // Use -File to invoke the script directly, avoiding string interpolation in -Command
      const wrapperPath = join(tmpdir(), 'codeck-hosts-cleanup-wrapper.ps1');
      writeFileSync(wrapperPath, [
        `Start-Process powershell -ArgumentList @(`,
        `  '-NoProfile'`,
        `  '-ExecutionPolicy'`,
        `  'Bypass'`,
        `  '-File'`,
        `  '${scriptPath.replace(/'/g, "''")}'`,
        `) -Verb RunAs -WindowStyle Hidden -Wait`,
      ].join('\n'), 'utf-8');
      await execa('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath,
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

    const rawScriptPath = join(config.projectPath, 'scripts', 'mdns-advertiser.cjs');
    if (!existsSync(rawScriptPath)) {
      console.log(chalk.red('mDNS advertiser script not found.'));
      console.log(chalk.dim(`Expected at: ${rawScriptPath}`));
      return;
    }

    let scriptPath: string;
    try {
      scriptPath = validateScriptPath(rawScriptPath, config.projectPath);
    } catch (err) {
      console.log(chalk.red(`Invalid script path: ${(err as Error).message}`));
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

    let validatedPort: number;
    try {
      validatedPort = validatePort(config.port);
    } catch (err) {
      console.log(chalk.red((err as Error).message));
      return;
    }
    const portArg = String(validatedPort);

    if (process.platform === 'win32') {
      // On Windows, elevate via UAC prompt so the advertiser can write the hosts file.
      // Write a launcher script to avoid interpolating paths into a -Command string.
      try {
        const launcherPath = join(tmpdir(), 'codeck-mdns-launcher.ps1');
        const escapedExecPath = process.execPath.replace(/'/g, "''");
        const escapedScriptPath = scriptPath.replace(/'/g, "''");
        writeFileSync(launcherPath, [
          `$p = Start-Process -FilePath '${escapedExecPath}' ` +
            `-ArgumentList @('${escapedScriptPath}', '${portArg}') ` +
            `-Verb RunAs -WindowStyle Hidden -PassThru`,
          `Write-Output $p.Id`,
        ].join('\n'), 'utf-8');

        const { stdout } = await execa('powershell', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherPath,
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
      // macOS/Linux: spawn detached, pass port as argv (array form — no shell interpolation)
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
        const pidStr = String(config.lanPid);
        try {
          execFileSync('taskkill', ['/PID', pidStr, '/F', '/T'], { stdio: 'ignore' });
        } catch {
          // Non-elevated terminal can't kill elevated process — elevate via script file
          const killScriptPath = join(tmpdir(), 'codeck-taskkill.ps1');
          writeFileSync(killScriptPath, [
            `Start-Process -FilePath 'taskkill' ` +
              `-ArgumentList @('/PID', '${pidStr}', '/F', '/T') ` +
              `-Verb RunAs -WindowStyle Hidden -Wait`,
          ].join('\n'), 'utf-8');
          await execa('powershell', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', killScriptPath,
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
