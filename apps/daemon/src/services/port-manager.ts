import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname, resolve, isAbsolute } from 'path';
import { execFileSync } from 'child_process';

// ── Config ──

const PROJECT_DIR = process.env.CODECK_PROJECT_DIR || '';
const COMPOSE_FILE = process.env.CODECK_COMPOSE_FILE || 'docker/compose.managed.yml';
const CODECK_PORT = parseInt(process.env.CODECK_DAEMON_PORT || '8080', 10);

// Safe parent directories for path validation (C2 fix)
const ALLOWED_PROJECT_PARENTS = ['/opt', '/home', '/workspace', '/var/lib'];

/**
 * Validate that a path is absolute, contains no traversal sequences,
 * and resolves within an allowed parent directory.
 */
function validatePath(rawPath: string, label: string): string {
  const resolved = resolve(rawPath);
  if (!isAbsolute(resolved)) {
    throw new Error(`${label} must be an absolute path, got: ${rawPath}`);
  }
  if (rawPath.includes('..')) {
    throw new Error(`${label} contains path traversal (..), rejected: ${rawPath}`);
  }
  const withinAllowed = ALLOWED_PROJECT_PARENTS.some(parent => resolved.startsWith(parent + '/') || resolved === parent);
  if (!withinAllowed) {
    throw new Error(`${label} resolves outside allowed directories (${ALLOWED_PROJECT_PARENTS.join(', ')}): ${resolved}`);
  }
  return resolved;
}

let mappedPorts: Set<number> = new Set();
let initialized = false;

// ── Init ──

export interface DaemonPortManagerOpts {
  projectDir?: string;
  composeFile?: string;
  codeckPort?: number;
}

export function initDaemonPortManager(opts?: DaemonPortManagerOpts): void {
  const projectDir = opts?.projectDir || PROJECT_DIR;
  if (!projectDir) {
    console.log('[Daemon/PortManager] CODECK_PROJECT_DIR not set — port management disabled');
    return;
  }

  // C2: Validate project directory before using it in Docker commands
  try {
    validatePath(projectDir, 'CODECK_PROJECT_DIR');
  } catch (e) {
    console.error(`[Daemon/PortManager] ${(e as Error).message} — port management disabled`);
    return;
  }

  // Read existing override to recover state
  const overridePath = join(projectDir, 'docker/compose.override.yml');
  if (existsSync(overridePath)) {
    try {
      const content = readFileSync(overridePath, 'utf8');
      // Parse port lines: - "NNNN:NNNN"
      const portMatches = content.matchAll(/-\s*"(\d+):\d+"/g);
      for (const match of portMatches) {
        mappedPorts.add(parseInt(match[1], 10));
      }
    } catch {
      // Non-fatal: start with empty set
    }
  }

  // Always include the base managed ports (7777, 7778 are in the compose file itself)
  initialized = true;
  console.log(`[Daemon/PortManager] Initialized: projectDir=${projectDir}, extra ports=[${Array.from(mappedPorts).join(',')}]`);
}

// ── Port Operations ──

export function addPort(port: number): { success: boolean; restarting?: boolean; alreadyMapped?: boolean; error?: string } {
  if (!initialized || !PROJECT_DIR) {
    return { success: false, error: 'Port manager not initialized. Set CODECK_PROJECT_DIR.' };
  }

  if (mappedPorts.has(port)) {
    return { success: true, alreadyMapped: true };
  }

  // C6: Two-phase commit — write override with new state, restart,
  // then commit to in-memory set only on success. Restore file on failure.
  const previousPorts = new Set(mappedPorts);
  const nextPorts = new Set(mappedPorts);
  nextPorts.add(port);

  try {
    writeOverrideForPorts(nextPorts);
    restartRuntimeContainer();
    // Restart succeeded — commit the new state
    mappedPorts = nextPorts;
    return { success: true, restarting: true };
  } catch (e) {
    // Restart failed — restore the override file to previous state
    try {
      writeOverrideForPorts(previousPorts);
    } catch {
      console.error('[Daemon/PortManager] Failed to restore override after failed restart');
    }
    return { success: false, error: (e as Error).message };
  }
}

export function removePort(port: number): { success: boolean; restarting?: boolean; notMapped?: boolean; error?: string } {
  if (!initialized || !PROJECT_DIR) {
    return { success: false, error: 'Port manager not initialized. Set CODECK_PROJECT_DIR.' };
  }

  if (!mappedPorts.has(port)) {
    return { success: true, notMapped: true };
  }

  // C6: Two-phase commit — write override with new state, restart,
  // then commit to in-memory set only on success. Restore file on failure.
  const previousPorts = new Set(mappedPorts);
  const nextPorts = new Set(mappedPorts);
  nextPorts.delete(port);

  try {
    writeOverrideForPorts(nextPorts);
    restartRuntimeContainer();
    // Restart succeeded — commit the new state
    mappedPorts = nextPorts;
    return { success: true, restarting: true };
  } catch (e) {
    // Restart failed — restore the override file to previous state
    try {
      writeOverrideForPorts(previousPorts);
    } catch {
      console.error('[Daemon/PortManager] Failed to restore override after failed restart');
    }
    return { success: false, error: (e as Error).message };
  }
}

export function getMappedPorts(): number[] {
  return Array.from(mappedPorts).sort((a, b) => a - b);
}

export function isPortExposed(port: number): boolean {
  return mappedPorts.has(port);
}

export function isPortManagerEnabled(): boolean {
  return initialized;
}

// ── Internal ──

function writeOverrideForPorts(ports: Set<number>): void {
  const overridePath = join(PROJECT_DIR, 'docker/compose.override.yml');
  const extraPorts = Array.from(ports).sort((a, b) => a - b);

  if (extraPorts.length === 0) {
    // No extra ports — remove override
    if (existsSync(overridePath)) {
      unlinkSync(overridePath);
      console.log('[Daemon/PortManager] Deleted override (no extra ports)');
    }
    return;
  }

  const portLines = extraPorts.map(p => `      - "${p}:${p}"`).join('\n');
  const yaml = [
    'services:',
    '  runtime:',
    '    ports:',
    portLines,
    '',
  ].join('\n');

  const dir = dirname(overridePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(overridePath, yaml, 'utf8');
  console.log(`[Daemon/PortManager] Wrote override: extra ports=[${extraPorts.join(',')}]`);
}

export function restartRuntimeContainer(): void {
  try {
    execFileSync('docker', [
      'compose', '-f', COMPOSE_FILE, 'up', '-d', '--no-deps', 'runtime',
    ], {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: 60_000,
    });
    console.log('[Daemon/PortManager] Runtime container restarted');
  } catch (e) {
    console.error('[Daemon/PortManager] Restart failed:', (e as Error).message);
    throw e;
  }
}
