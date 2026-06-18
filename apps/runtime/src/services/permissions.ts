import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { ACTIVE_AGENT } from './agent.js';

const ALL_PERMISSIONS = ['Read', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch'] as const;
type PermissionName = (typeof ALL_PERMISSIONS)[number];
type PermissionsMap = Record<PermissionName, boolean>;

const WORKSPACE = process.env.WORKSPACE || '/workspace';
const CONFIG_PATH = `${WORKSPACE}/.codeck/config.json`;

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

// ── MCP Server Permissions ──

export interface McpServerPermission {
  name: string;
  allowed: boolean;
  disabled: boolean; // server itself is disabled in mcp.json
}

/** Read MCP servers from mcp.json and merge with stored permission state */
export function getMcpPermissions(): McpServerPermission[] {
  const mcpJsonPath = join(dirname(ACTIVE_AGENT.settingsFile), 'mcp.json');
  const config = readConfig();
  const stored = (config.mcpPermissions || {}) as Record<string, boolean>;

  const servers: McpServerPermission[] = [];
  try {
    if (existsSync(mcpJsonPath)) {
      const mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
      for (const [name, cfg] of Object.entries(mcpJson.mcpServers || {})) {
        const serverCfg = cfg as Record<string, unknown>;
        servers.push({
          name,
          allowed: stored[name] ?? true, // default: allowed
          disabled: !!serverCfg.disabled,
        });
      }
    }
  } catch { /* non-fatal */ }
  return servers;
}

/** Toggle permission for a specific MCP server */
export function setMcpPermission(serverName: string, allowed: boolean): McpServerPermission[] {
  const config = readConfig();
  const stored = (config.mcpPermissions || {}) as Record<string, boolean>;
  stored[serverName] = allowed;
  config.mcpPermissions = stored;
  writeConfig(config);
  syncToClaudeSettings();
  return getMcpPermissions();
}

// ── Deny Rules ──

export interface DenyRule {
  pattern: string;
}

export function getDenyRules(): DenyRule[] {
  const settingsPath = ACTIVE_AGENT.settingsFile;
  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const deny = (settings.permissions?.deny || []) as string[];
      return deny.map(pattern => ({ pattern }));
    }
  } catch {}
  return [];
}

// ── Sync to Claude Settings ──

export function syncToClaudeSettings(
  settingsFile: string = ACTIVE_AGENT.settingsFile,
): void {
  const settingsPath = settingsFile;
  const perms = getPermissions();
  const enabled = ALL_PERMISSIONS.filter(p => perms[p]);
  const mcpPerms = getMcpPermissions();

  try {
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    }
    const permissions = (settings.permissions || {}) as Record<string, unknown>;

    // Include MCP server tools — only allowed & non-disabled servers
    const mcpAllow: string[] = [];
    for (const server of mcpPerms) {
      if (server.allowed && !server.disabled) {
        mcpAllow.push(`mcp__${server.name}`);
      }
    }

    // Path-scoped permissions (always include .codeck and .claude access)
    const pathScoped = [
      'Read(/workspace/.codeck/**)',
      'Edit(/workspace/.codeck/**)',
      'Write(/workspace/.codeck/**)',
      'Edit(/root/.claude/**)',
      'Write(/root/.claude/**)',
      'Read(/root/.claude/**)',
    ];

    permissions.allow = [...enabled, ...pathScoped, ...mcpAllow];
    settings.permissions = permissions;

    const dir = dirname(settingsPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, '\t'));
    console.log(`[Permissions] Synced: ${enabled.length} basic + ${mcpAllow.length} MCP servers`);
  } catch (e) {
    console.log('[Permissions] Warning: could not sync settings:', (e as Error).message);
  }
}
