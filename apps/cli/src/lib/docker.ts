import { execa, type Options as ExecaOptions } from 'execa';
import { existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { CodeckConfig, CodeckMode } from './config.js';

/** Default timeouts for Docker operations (ms) */
const TIMEOUT = {
  UP: 5 * 60_000,      // 5 minutes — compose up with optional build
  DOWN: 60_000,         // 1 minute — compose down
  BUILD: 10 * 60_000,   // 10 minutes — base image build
  // logs has no timeout — it's a streaming operation the user exits manually
} as const;

interface ComposeOpts {
  projectPath: string;
  lanMode?: CodeckConfig['lanMode'];
  mode?: CodeckMode;
  dev?: boolean;
}

/**
 * Validate that projectPath is a real directory containing docker/compose.yml.
 * Prevents use of malicious paths as cwd for Docker commands.
 */
function validateProjectPath(projectPath: string): void {
  if (!projectPath) {
    throw new Error('Project path is not set. Run `codeck init` first.');
  }
  const resolved = resolve(projectPath);
  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Project path is not a directory: ${resolved}`);
    }
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Project path does not exist: ${resolved}`);
    }
    throw err;
  }
  if (!existsSync(join(resolved, 'docker/compose.yml'))) {
    throw new Error(`docker/compose.yml not found in project path: ${resolved}`);
  }
}

function composeFiles(opts: ComposeOpts): string[] {
  if (opts.mode === 'gateway') {
    // Gateway mode uses its own compose file — no dev/LAN overlays
    return ['-f', 'docker/compose.gateway.yml'];
  }
  const files = ['-f', 'docker/compose.yml'];
  if (opts.dev) {
    files.push('-f', 'docker/compose.dev.yml');
  }
  if (opts.lanMode === 'host') {
    files.push('-f', 'docker/compose.lan.yml');
  }
  return files;
}

function composeExecOpts(projectPath: string): ExecaOptions {
  validateProjectPath(projectPath);
  return { cwd: resolve(projectPath) };
}

export async function composeUp(opts: ComposeOpts & { build?: boolean }): Promise<void> {
  const args = ['compose', ...composeFiles(opts), 'up', '-d'];
  if (opts.build || opts.dev) {
    args.push('--build');
  }
  await execa('docker', args, {
    ...composeExecOpts(opts.projectPath),
    stdio: 'inherit',
    timeout: TIMEOUT.UP,
  });
}

export async function composeDown(opts: ComposeOpts): Promise<void> {
  const args = ['compose', ...composeFiles(opts), 'down'];
  await execa('docker', args, {
    ...composeExecOpts(opts.projectPath),
    stdio: 'inherit',
    timeout: TIMEOUT.DOWN,
  });
}

export async function composeLogs(opts: ComposeOpts & { lines?: number }): Promise<void> {
  const args = ['compose', ...composeFiles(opts), 'logs', '-f', '--tail', String(opts.lines ?? 50)];
  await execa('docker', args, {
    ...composeExecOpts(opts.projectPath),
    stdio: 'inherit',
  });
}

export async function buildBaseImage(projectPath: string): Promise<void> {
  await execa('docker', ['build', '-t', 'codeck-base', '-f', 'Dockerfile.base', '.'], {
    cwd: projectPath,
    stdio: 'inherit',
    timeout: TIMEOUT.BUILD,
  });
}
