import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { ACTIVE_AGENT } from './agent.js';

const ALL_PERMISSIONS = ['Read', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch'] as const;
type PermissionName = (typeof ALL_PERMISSIONS)[number];
type PermissionsMap = Record<PermissionName, boolean>;

const CODECK_DIR = process.env.CODECK_DIR || '/workspace/.codeck';
const CONFIG_PATH = `${CODECK_DIR}/config.json`;

function readConfig(): Record<string, unknown> {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function writeConfig(config: Record<string, unknown>): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function getPermissions(): PermissionsMap {
  const config = readConfig();
  const stored = config.permissions as Partial<PermissionsMap> | undefined;
  const result = {} as PermissionsMap;
  for (const perm of ALL_PERMISSIONS) {
    result[perm] = stored?.[perm] ?? true;
  }
  return result;
}

export function setPermissions(perms: Partial<PermissionsMap>): PermissionsMap {
  const config = readConfig();
  const current = getPermissions();
  for (const perm of ALL_PERMISSIONS) {
    if (perm in perms) {
      current[perm] = !!perms[perm];
    }
  }
  config.permissions = current;
  writeConfig(config);
  syncToClaudeSettings();
  return current;
}

export function syncToClaudeSettings(): void {
  const settingsPath = ACTIVE_AGENT.settingsFile;
  const perms = getPermissions();
  const enabled = ALL_PERMISSIONS.filter(p => perms[p]);

  try {
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    }
    const permissions = (settings.permissions || {}) as Record<string, unknown>;
    permissions.allow = enabled;
    settings.permissions = permissions;

    const dir = dirname(settingsPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log(`[Permissions] Synced to settings.json: ${enabled.join(', ')}`);
  } catch (e) {
    console.log('[Permissions] Warning: could not sync settings:', (e as Error).message);
  }
}
