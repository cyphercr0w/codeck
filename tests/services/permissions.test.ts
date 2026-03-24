/**
 * Unit tests for services/permissions.ts
 *
 * Tests getPermissions, setPermissions, syncToClaudeSettings,
 * default permissions, and file security properties.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, dirname } from 'path';

// Mock agent.js before importing permissions
vi.mock('../../apps/runtime/src/services/agent.js', () => ({
  ACTIVE_AGENT: {
    id: 'claude',
    name: 'Claude',
    command: 'claude',
    flags: { resume: '--resume', continue: '--continue', version: '--version' },
    instructionFile: 'CLAUDE.md',
    configDir: `${process.env.CLAUDE_CONFIG_DIR || '/tmp/codeck-test/.claude'}`,
    credentialsFile: `${process.env.CLAUDE_CONFIG_DIR || '/tmp/codeck-test/.claude'}/.credentials.json`,
    configFile: `${process.env.HOME || '/root'}/.claude.json`,
    settingsFile: `${process.env.CLAUDE_CONFIG_DIR || '/tmp/codeck-test/.claude'}/settings.json`,
    projectsDir: `${process.env.CLAUDE_CONFIG_DIR || '/tmp/codeck-test/.claude'}/projects`,
  },
}));

import {
  getPermissions,
  setPermissions,
  syncToClaudeSettings,
} from '../../apps/runtime/src/services/permissions.js';
import { ACTIVE_AGENT } from '../../apps/runtime/src/services/agent.js';

const WORKSPACE = process.env.WORKSPACE!;
const CODECK_DIR = join(WORKSPACE, '.codeck');
const CONFIG_PATH = join(CODECK_DIR, 'config.json');
const SETTINGS_PATH = ACTIVE_AGENT.settingsFile;
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR!;

describe('services/permissions.ts - getPermissions', () => {
  beforeEach(() => {
    mkdirSync(CODECK_DIR, { recursive: true });
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
  });

  afterEach(() => {
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
  });

  it('should return all permissions enabled by default when no config exists', () => {
    const perms = getPermissions();
    expect(perms.Read).toBe(true);
    expect(perms.Edit).toBe(true);
    expect(perms.Write).toBe(true);
    expect(perms.Bash).toBe(true);
    expect(perms.WebFetch).toBe(true);
    expect(perms.WebSearch).toBe(true);
  });

  it('should return all 6 permission keys', () => {
    const perms = getPermissions();
    const keys = Object.keys(perms).sort();
    expect(keys).toEqual(['Bash', 'Edit', 'Read', 'WebFetch', 'WebSearch', 'Write']);
  });

  it('should read permissions from config.json when present', () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({
      permissions: {
        Read: true,
        Edit: true,
        Write: true,
        Bash: false,
        WebFetch: false,
        WebSearch: true,
      },
    }));

    const perms = getPermissions();
    expect(perms.Bash).toBe(false);
    expect(perms.WebFetch).toBe(false);
    expect(perms.Read).toBe(true);
    expect(perms.WebSearch).toBe(true);
  });

  it('should default missing permissions to true', () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({
      permissions: {
        Read: false,
        // Other permissions not set — should default to true
      },
    }));

    const perms = getPermissions();
    expect(perms.Read).toBe(false);
    expect(perms.Edit).toBe(true);
    expect(perms.Write).toBe(true);
    expect(perms.Bash).toBe(true);
  });

  it('should handle corrupted config.json gracefully', () => {
    writeFileSync(CONFIG_PATH, 'not valid json{{{');
    const perms = getPermissions();
    // Should return defaults (all true) when config is corrupted
    expect(perms.Read).toBe(true);
    expect(perms.Edit).toBe(true);
  });
});

describe('services/permissions.ts - setPermissions', () => {
  beforeEach(() => {
    mkdirSync(CODECK_DIR, { recursive: true });
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
    if (existsSync(SETTINGS_PATH)) rmSync(SETTINGS_PATH);
  });

  afterEach(() => {
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
    if (existsSync(SETTINGS_PATH)) rmSync(SETTINGS_PATH);
  });

  it('should persist permissions to config.json', () => {
    setPermissions({ Bash: false, WebFetch: false });

    expect(existsSync(CONFIG_PATH)).toBe(true);
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    expect(config.permissions.Bash).toBe(false);
    expect(config.permissions.WebFetch).toBe(false);
    expect(config.permissions.Read).toBe(true); // Unchanged = default true
  });

  it('should return the updated permissions map', () => {
    const result = setPermissions({ Edit: false });
    expect(result.Edit).toBe(false);
    expect(result.Read).toBe(true);
    expect(result.Bash).toBe(true);
  });

  it('should merge with existing permissions (not replace)', () => {
    setPermissions({ Bash: false });
    const result = setPermissions({ WebSearch: false });

    // Bash should still be false from first call
    expect(result.Bash).toBe(false);
    expect(result.WebSearch).toBe(false);
    expect(result.Read).toBe(true);
  });

  it('should preserve other config keys when writing', () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ theme: 'dark', version: 1 }));
    setPermissions({ Bash: false });

    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    expect(config.theme).toBe('dark');
    expect(config.version).toBe(1);
    expect(config.permissions.Bash).toBe(false);
  });

  it('should create config.json with mode 0o600', () => {
    setPermissions({ Read: true });

    const mode = statSync(CONFIG_PATH).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('should coerce truthy/falsy values to boolean', () => {
    // Pass non-boolean values
    setPermissions({ Bash: 0 as any, Read: 1 as any });

    const perms = getPermissions();
    expect(perms.Bash).toBe(false);
    expect(perms.Read).toBe(true);
  });
});

describe('services/permissions.ts - syncToClaudeSettings', () => {
  beforeEach(() => {
    mkdirSync(CODECK_DIR, { recursive: true });
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
    if (existsSync(SETTINGS_PATH)) rmSync(SETTINGS_PATH);
  });

  afterEach(() => {
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
    if (existsSync(SETTINGS_PATH)) rmSync(SETTINGS_PATH);
    // Clean up .claude.json if created
    const claudeJsonPath = join(dirname(SETTINGS_PATH), '.claude.json');
    if (existsSync(claudeJsonPath)) rmSync(claudeJsonPath);
  });

  it('should create settings.json with permissions.allow array', () => {
    // All permissions enabled by default
    syncToClaudeSettings();

    expect(existsSync(SETTINGS_PATH)).toBe(true);
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    expect(settings.permissions).toBeDefined();
    expect(Array.isArray(settings.permissions.allow)).toBe(true);
    expect(settings.permissions.allow).toContain('Read');
    expect(settings.permissions.allow).toContain('Edit');
    expect(settings.permissions.allow).toContain('Write');
    expect(settings.permissions.allow).toContain('Bash');
  });

  it('should only include enabled permissions in allow array', () => {
    setPermissions({ Bash: false, WebFetch: false });
    // setPermissions calls syncToClaudeSettings internally

    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    expect(settings.permissions.allow).not.toContain('Bash');
    expect(settings.permissions.allow).not.toContain('WebFetch');
    expect(settings.permissions.allow).toContain('Read');
    expect(settings.permissions.allow).toContain('Edit');
  });

  it('should preserve existing settings.json keys', () => {
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      theme: 'dark',
      someOtherSetting: true,
    }));

    syncToClaudeSettings();

    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    expect(settings.theme).toBe('dark');
    expect(settings.someOtherSetting).toBe(true);
    expect(settings.permissions.allow).toBeDefined();
  });

  it('should include MCP server tool prefixes from mcp.json', () => {
    // Create mcp.json with MCP servers
    const mcpJsonPath = join(dirname(SETTINGS_PATH), 'mcp.json');
    writeFileSync(mcpJsonPath, JSON.stringify({
      mcpServers: {
        'context7': { command: 'npx', args: ['context7'] },
        'eslint': { command: 'npx', args: ['eslint-mcp'] },
      },
    }));

    syncToClaudeSettings();

    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    expect(settings.permissions.allow).toContain('mcp__context7');
    expect(settings.permissions.allow).toContain('mcp__eslint');
  });

  it('should not throw when settings directory does not exist', () => {
    // Remove settings dir
    rmSync(dirname(SETTINGS_PATH), { recursive: true, force: true });
    // syncToClaudeSettings should create the dir
    expect(() => syncToClaudeSettings()).not.toThrow();
  });
});
