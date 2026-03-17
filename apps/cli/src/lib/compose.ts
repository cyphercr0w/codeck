import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';

const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Validate that a port number is within the valid TCP/UDP range [1, 65535].
 */
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

/**
 * Resolve a target path and validate it is within the expected base directory.
 * Prevents symlink traversal and path escape attacks.
 * Throws if the resolved path escapes the base directory.
 */
function validatePathWithinBase(targetPath: string, baseDir: string): string {
  const resolvedBase = resolve(baseDir);
  // Resolve symlinks on the parent directory (target file may not exist yet)
  const targetDir = join(targetPath, '..');
  const resolvedDir = existsSync(targetDir)
    ? realpathSync(targetDir)
    : resolve(targetDir);
  const resolvedTarget = join(resolvedDir, targetPath.split('/').pop()!);

  if (!resolvedTarget.startsWith(resolvedBase + '/') && resolvedTarget !== resolvedBase) {
    throw new Error(
      `Path traversal detected: resolved path "${resolvedTarget}" is outside the project directory "${resolvedBase}"`
    );
  }
  return resolvedTarget;
}

/**
 * Generate docker/compose.override.yml content.
 * Matches the format used by port-manager.ts inside the container.
 */
export function generateOverrideYaml(extraPorts: number[], codeckPort: number): string {
  if (extraPorts.length === 0) return '';

  const invalidPorts = extraPorts.filter(p => !isValidPort(p));
  if (invalidPorts.length > 0) {
    throw new Error(
      `Invalid port number(s): ${invalidPorts.join(', ')}. Ports must be integers in range [${MIN_PORT}, ${MAX_PORT}].`
    );
  }
  if (!isValidPort(codeckPort)) {
    throw new Error(
      `Invalid codeck port: ${codeckPort}. Port must be an integer in range [${MIN_PORT}, ${MAX_PORT}].`
    );
  }

  const allPorts = [...new Set([codeckPort, ...extraPorts])].sort((a, b) => a - b);
  const overridePorts = extraPorts.filter(p => p !== codeckPort).sort((a, b) => a - b);

  if (overridePorts.length === 0) return '';

  const doc = {
    services: {
      sandbox: {  // Isolated mode service name
        ports: overridePorts.map(p => `${p}:${p}`),
        environment: [
          `CODECK_MAPPED_PORTS=${allPorts.join(',')}`,
        ],
      },
    },
  };

  return stringify(doc);
}

/**
 * Generate .env file content.
 */
export function generateEnvFile(vars: Record<string, string>): string {
  return Object.entries(vars)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => {
      // Quote values that contain special characters
      if (/[=\s#"'\\]/.test(v)) {
        return `${k}="${v.replace(/["\\]/g, '\\$&')}"`;
      }
      return `${k}=${v}`;
    })
    .join('\n') + '\n';
}

/**
 * Read and parse an existing .env file.
 */
export function readEnvFile(projectPath: string): Record<string, string> {
  const envPath = join(projectPath, '.env');
  if (!existsSync(envPath)) return {};
  const content = readFileSync(envPath, 'utf8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

/**
 * Write docker/compose.override.yml to the project directory.
 */
export function writeOverrideFile(projectPath: string, content: string): void {
  if (!content) return;
  const targetPath = join(projectPath, 'docker/compose.override.yml');
  const validatedPath = validatePathWithinBase(targetPath, projectPath);
  writeFileSync(validatedPath, content, 'utf8');
}

/**
 * Write .env file to the project directory.
 */
export function writeEnvFile(projectPath: string, content: string): void {
  writeFileSync(join(projectPath, '.env'), content, 'utf8');
}

/**
 * Check if docker/compose.override.yml exists.
 */
export function overrideExists(projectPath: string): boolean {
  return existsSync(join(projectPath, 'docker/compose.override.yml'));
}

/**
 * Check if .env file exists.
 */
export function envFileExists(projectPath: string): boolean {
  return existsSync(join(projectPath, '.env'));
}
