import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';

/**
 * Generate docker/compose.override.yml content.
 * Matches the format used by port-manager.ts inside the container.
 */
export function generateOverrideYaml(extraPorts: number[], codeckPort: number): string {
  if (extraPorts.length === 0) return '';

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
  writeFileSync(join(projectPath, 'docker/compose.override.yml'), content, 'utf8');
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
