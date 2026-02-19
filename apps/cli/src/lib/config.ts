import Conf from 'conf';
import { openSync, closeSync, unlinkSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';

export type CodeckMode = 'local' | 'gateway';

export interface CodeckConfig {
  projectPath: string;
  port: number;
  extraPorts: number[];
  lanMode: 'none' | 'host' | 'mdns';
  mode: CodeckMode;
  initialized: boolean;
  os: 'windows' | 'macos' | 'linux';
  lanPid?: number;
}

const schema = {
  projectPath: { type: 'string' as const, default: '' },
  port: { type: 'number' as const, default: 80 },
  extraPorts: { type: 'array' as const, default: [] as number[], items: { type: 'number' as const } },
  lanMode: { type: 'string' as const, default: 'none', enum: ['none', 'host', 'mdns'] },
  mode: { type: 'string' as const, default: 'local', enum: ['local', 'gateway'] },
  initialized: { type: 'boolean' as const, default: false },
  os: { type: 'string' as const, default: 'linux', enum: ['windows', 'macos', 'linux'] },
  lanPid: { type: 'number' as const },
};

const config = new Conf<CodeckConfig>({
  projectName: 'codeck',
  schema,
});

export function getConfig(): CodeckConfig {
  return {
    projectPath: config.get('projectPath'),
    port: config.get('port'),
    extraPorts: config.get('extraPorts'),
    lanMode: config.get('lanMode'),
    mode: config.get('mode'),
    initialized: config.get('initialized'),
    os: config.get('os'),
    lanPid: config.get('lanPid'),
  };
}

/**
 * Advisory file lock to prevent concurrent CLI config writes.
 * Uses O_CREAT | O_EXCL to atomically create a lock file.
 */
function getLockPath(): string {
  return join(dirname(config.path), 'codeck.lock');
}

export function withConfigLock<T>(fn: () => T): T {
  const lockPath = getLockPath();
  let fd: number | null = null;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Another codeck command is writing config. Please wait and retry.');
    }
    throw err;
  }
  try {
    return fn();
  } finally {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* lock file may already be gone */ }
  }
}

export function setConfig(partial: Partial<CodeckConfig>): void {
  withConfigLock(() => {
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) {
        config.set(key as keyof CodeckConfig, value);
      }
    }
  });
}

export function isInitialized(): boolean {
  return config.get('initialized');
}

export function getProjectPath(): string {
  return config.get('projectPath');
}

export function getConfigPath(): string {
  return config.path;
}

export function deleteLanPid(): void {
  withConfigLock(() => config.delete('lanPid'));
}

export function resetConfig(): void {
  withConfigLock(() => config.clear());
}
