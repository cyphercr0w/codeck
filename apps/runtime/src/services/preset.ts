import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, realpathSync, statSync, renameSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.WORKSPACE || '/workspace';
const WORKSPACE_CODECK = join(WORKSPACE, '.codeck');
const CONFIG_FILE = join(WORKSPACE_CODECK, 'config.json');
const TEMPLATES_DIR = resolve(join(__dirname, '../templates/presets'));
const BACKUPS_DIR = join(WORKSPACE_CODECK, 'backups');

// Migrate config.json from old CODECK_DIR location to WORKSPACE/.codeck/
// Prevents existing users from seeing the preset selector again after the path change.
const LEGACY_CONFIG = join(process.env.CODECK_DIR || '/data/.codeck', 'config.json');
if (!existsSync(CONFIG_FILE) && existsSync(LEGACY_CONFIG)) {
  try {
    if (!existsSync(WORKSPACE_CODECK)) mkdirSync(WORKSPACE_CODECK, { recursive: true });
    writeFileSync(CONFIG_FILE, readFileSync(LEGACY_CONFIG, 'utf-8'), { mode: 0o600 });
    console.log(`[Preset] Migrated config.json from ${LEGACY_CONFIG} → ${CONFIG_FILE}`);
  } catch (e) {
    console.warn(`[Preset] Failed to migrate config.json:`, (e as Error).message);
  }
}

// Strict allowlist for preset IDs: alphanumeric, hyphens, underscores only
const VALID_PRESET_ID = /^[a-zA-Z0-9_-]+$/;

const home = process.env.HOME || '/root';

// Allowed destination path prefixes for manifest files
const ALLOWED_DEST_PREFIXES = [
  `${WORKSPACE}/`,
  `${home}/.claude/`,
  `${home}/`,
];

/**
 * Rewrite manifest paths from Docker defaults (/root/, /workspace/) to
 * the actual runtime paths. This allows a single manifest.json to work
 * across Docker, systemd, and cli-local deployment modes.
 */
function rewritePath(p: string): string {
  if (p.startsWith('/root/')) {
    return `${home}/${p.slice('/root/'.length)}`;
  }
  if (p.startsWith('/workspace/')) {
    return `${WORKSPACE}/${p.slice('/workspace/'.length)}`;
  }
  if (p === '/workspace') {
    return WORKSPACE;
  }
  return p;
}

// ── Types ────────────────────────────────────────────────────────────

export interface RecursiveDirEntry {
  src: string;
  dest: string;
  recursive: boolean;
  skipIfExists: boolean;
}

export interface PresetManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  icon: string;
  tags: string[];
  extends: string | null;
  files: Array<{ src: string; dest: string; skipIfExists?: boolean }>;
  directories: string[];
  recursive_dirs?: RecursiveDirEntry[];
}

interface PresetConfig {
  presetId: string;
  presetName: string;
  configuredAt: string;
  version: string;
}

export interface PresetStatus {
  configured: boolean;
  presetId: string | null;
  presetName: string | null;
  configuredAt: string | null;
  version: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
}

// ── Validation ──────────────────────────────────────────────────────

/** Validate that a preset ID contains only safe characters (no path traversal). */
export function isValidPresetId(presetId: string): boolean {
  return VALID_PRESET_ID.test(presetId);
}

/** Validate that a destination path is within allowed directories.
 *  Uses realpathSync to resolve symlinks — prevents symlink-based path traversal. */
function isAllowedDestPath(dest: string): boolean {
  const resolved = resolve(dest);
  try {
    const real = realpathSync(resolved);
    return ALLOWED_DEST_PREFIXES.some(prefix => real.startsWith(prefix));
  } catch {
    // Path doesn't exist yet (new file/dir) — validate resolved path
    return ALLOWED_DEST_PREFIXES.some(prefix => resolved.startsWith(prefix));
  }
}

/** Validate manifest structure at runtime. Returns null if invalid. */
function validateManifest(data: unknown): PresetManifest | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const m = data as Record<string, unknown>;
  if (typeof m.id !== 'string' || !m.id) return null;
  if (typeof m.name !== 'string' || !m.name) return null;
  if (typeof m.description !== 'string') return null;
  if (typeof m.version !== 'string') return null;
  if (typeof m.author !== 'string') return null;
  if (typeof m.icon !== 'string') return null;
  if (!Array.isArray(m.tags) || !m.tags.every((t: unknown) => typeof t === 'string')) return null;
  if (m.extends !== null && typeof m.extends !== 'string') return null;
  if (!Array.isArray(m.files)) return null;
  for (const f of m.files) {
    if (!f || typeof f !== 'object') return null;
    const file = f as Record<string, unknown>;
    if (typeof file.src !== 'string' || typeof file.dest !== 'string') return null;
    if (file.skipIfExists !== undefined && typeof file.skipIfExists !== 'boolean') return null;
  }
  if (!Array.isArray(m.directories)) return null;
  for (const d of m.directories) {
    if (typeof d !== 'string') return null;
  }
  // Optional recursive_dirs
  if (m.recursive_dirs !== undefined) {
    if (!Array.isArray(m.recursive_dirs)) return null;
    for (const rd of m.recursive_dirs) {
      if (!rd || typeof rd !== 'object') return null;
      const entry = rd as Record<string, unknown>;
      if (typeof entry.src !== 'string' || typeof entry.dest !== 'string') return null;
      if (typeof entry.recursive !== 'boolean') return null;
      if (typeof entry.skipIfExists !== 'boolean') return null;
    }
  }
  return data as PresetManifest;
}

/** Compare semver strings: returns true if available is strictly newer than installed. */
function isNewerVersion(installed: string, available: string): boolean {
  const parse = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0);
  const [iMaj, iMin, iPat] = parse(installed);
  const [aMaj, aMin, aPat] = parse(available);
  if (aMaj !== iMaj) return aMaj > iMaj;
  if (aMin !== iMin) return aMin > iMin;
  return aPat > iPat;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Scan all preset directories for manifest.json and return available presets.
 * Sorted with "default" first.
 */
export function listPresets(): PresetManifest[] {
  const presets: PresetManifest[] = [];

  if (!existsSync(TEMPLATES_DIR)) return presets;

  for (const dir of readdirSync(TEMPLATES_DIR)) {
    const manifestPath = join(TEMPLATES_DIR, dir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const manifest = validateManifest(raw);
      if (manifest) {
        presets.push(manifest);
      } else {
        console.warn(`[Preset] Invalid manifest schema at ${manifestPath}`);
      }
    } catch (err) {
      console.error(`[Preset] Error reading manifest at ${manifestPath}:`, (err as Error).message);
    }
  }

  // Sort: "default" first, then alphabetical
  presets.sort((a, b) => {
    if (a.id === 'default') return -1;
    if (b.id === 'default') return 1;
    return a.name.localeCompare(b.name);
  });

  return presets;
}

/**
 * Read /workspace/.codeck/config.json to check if a preset has been applied.
 */
export function getPresetStatus(): PresetStatus {
  const empty: PresetStatus = { configured: false, presetId: null, presetName: null, configuredAt: null, version: null, availableVersion: null, updateAvailable: false };
  if (!existsSync(CONFIG_FILE)) return empty;
  try {
    const config: PresetConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    // Check if the template has a newer version than what's installed
    const manifest = config.presetId ? loadManifest(config.presetId) : null;
    const availableVersion = manifest?.version ?? null;
    const updateAvailable = !!(availableVersion && config.version && isNewerVersion(config.version, availableVersion));
    return {
      configured: true,
      presetId: config.presetId,
      presetName: config.presetName,
      configuredAt: config.configuredAt,
      version: config.version,
      availableVersion,
      updateAvailable,
    };
  } catch (e) {
    console.warn('[Preset] Failed to read config:', (e as Error).message);
    return empty;
  }
}

/**
 * Apply a preset by reading its manifest and copying declared files.
 * Supports `extends` with circular-reference guard (max depth 5).
 */
export async function applyPreset(presetId: string, force = false): Promise<void> {
  await applyPresetRecursive(presetId, new Set(), 0, force);
}

// ── Internal ─────────────────────────────────────────────────────────

/**
 * Migrate old flat rules/ layout to rules/base/ + rules/user/ structure.
 * Only runs once (when old-style loose files exist). Idempotent.
 */
function migrateRulesLayout(codeckDir: string): void {
  const rulesDir = join(codeckDir, 'rules');
  if (!existsSync(rulesDir)) return;

  // Move ALL loose .md files in rules/ to rules/user/.
  // base/ files are preset-managed (overwritten on update), so user customizations
  // must go to user/ where they're protected from overwrites.
  const userDir = join(rulesDir, 'user');
  try {
    for (const entry of readdirSync(rulesDir)) {
      const entryPath = join(rulesDir, entry);
      if (!statSync(entryPath).isFile()) continue;
      if (!entry.endsWith('.md')) continue;
      const userDest = join(userDir, entry);
      if (existsSync(userDest)) {
        console.log(`[Preset]   SKIP migration ${entryPath} (${userDest} already exists)`);
        continue;
      }
      if (!existsSync(userDir)) mkdirSync(userDir, { recursive: true });
      renameSync(entryPath, userDest);
      console.log(`[Preset]   MIGRATE ${entryPath} → ${userDest}`);
    }
  } catch (e) {
    console.warn(`[Preset]   Failed to migrate rules:`, (e as Error).message);
  }
}

// Prefix that identifies preset-managed hooks (vs user-added hooks)
// Use rewritePath to handle non-Docker deployments where WORKSPACE differs
const PRESET_HOOK_PREFIX = rewritePath('/workspace/.codeck/scripts/');

/**
 * Extract all command strings from a hooks entry array.
 * Each entry has { matcher, hooks: [{ type, command }] }.
 */
function extractCommands(entries: unknown[]): Set<string> {
  const cmds = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const hooks = (entry as Record<string, unknown>).hooks;
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) {
      if (h && typeof h === 'object' && typeof (h as Record<string, unknown>).command === 'string') {
        cmds.add((h as Record<string, unknown>).command as string);
      }
    }
  }
  return cmds;
}

/**
 * Merge preset hooks into an existing settings.json (additive-only).
 * Only adds hooks whose command points to PRESET_HOOK_PREFIX.
 * Never removes hooks, never touches permissions or other fields.
 */
function mergePresetHooks(presetDir: string): void {
  const templatePath = join(presetDir, 'ecc', 'settings.json');
  const settingsDest = rewritePath('/root/.claude/settings.json');

  if (!existsSync(templatePath) || !existsSync(settingsDest)) return;

  try {
    const template = JSON.parse(readFileSync(templatePath, 'utf-8'));
    const current = JSON.parse(readFileSync(settingsDest, 'utf-8'));

    const templateHooks = template.hooks;
    if (!templateHooks || typeof templateHooks !== 'object') return;

    if (!current.hooks || typeof current.hooks !== 'object') {
      current.hooks = {};
    }

    let added = 0;
    for (const [event, templateEntries] of Object.entries(templateHooks)) {
      if (!Array.isArray(templateEntries)) continue;

      // Get existing commands for this event
      const currentEntries: unknown[] = Array.isArray(current.hooks[event]) ? current.hooks[event] : [];
      const existingCmds = extractCommands(currentEntries);

      // Add missing preset entries
      for (const entry of templateEntries) {
        if (!entry || typeof entry !== 'object') continue;
        const hooks = (entry as Record<string, unknown>).hooks;
        if (!Array.isArray(hooks)) continue;

        // Rewrite command paths for non-Docker deployments
        const rewrittenEntry = JSON.parse(JSON.stringify(entry));
        const rewrittenHooks = (rewrittenEntry as Record<string, unknown>).hooks as Array<Record<string, unknown>>;
        for (const h of rewrittenHooks) {
          if (typeof h.command === 'string') {
            h.command = rewritePath(h.command);
          }
        }

        // Check if ALL commands in this entry are preset-managed
        const cmds = rewrittenHooks
          .filter(h => typeof h.command === 'string')
          .map(h => h.command as string);

        const allPresetManaged = cmds.every(c => c.includes(PRESET_HOOK_PREFIX));
        if (!allPresetManaged) continue; // skip non-preset hooks

        const allExist = cmds.every(c => existingCmds.has(c));
        if (allExist) continue; // already installed

        if (!Array.isArray(current.hooks[event])) {
          current.hooks[event] = [];
        }
        current.hooks[event].push(rewrittenEntry);
        added++;
        console.log(`[Preset]   MERGE hook: ${event} ← ${cmds.join(', ')}`);
      }
    }

    if (added > 0) {
      writeFileSync(settingsDest, JSON.stringify(current, null, 2));
      console.log(`[Preset]   Merged ${added} new hook(s) into settings.json`);
    }
  } catch (e) {
    console.warn(`[Preset]   Failed to merge hooks:`, (e as Error).message);
  }
}

async function applyPresetRecursive(presetId: string, visited: Set<string>, depth: number, force: boolean): Promise<void> {
  if (depth > 5) {
    throw new Error(`Preset extends chain too deep (>5). Possible circular reference.`);
  }
  if (visited.has(presetId)) {
    throw new Error(`Circular preset extends detected: "${presetId}" already applied in this chain.`);
  }
  visited.add(presetId);

  // Run rules layout migration at the top-level call only
  if (depth === 0) {
    migrateRulesLayout(WORKSPACE_CODECK);
  }

  const manifest = loadManifest(presetId);
  if (!manifest) {
    throw new Error(`Preset "${presetId}" not found.`);
  }

  // Cross-validate manifest.id matches the directory name
  if (manifest.id !== presetId) {
    throw new Error(`Manifest id "${manifest.id}" doesn't match preset directory "${presetId}".`);
  }

  console.log(`[Preset] Applying "${manifest.id}" (${manifest.name})...`);

  // If this preset extends another, apply the parent first
  if (manifest.extends) {
    await applyPresetRecursive(manifest.extends, visited, depth + 1, force);
  }

  // Create declared directories (validate paths, rewrite for deployment mode)
  for (const rawDir of manifest.directories) {
    const dir = rewritePath(rawDir);
    if (!isAllowedDestPath(dir)) {
      console.warn(`[Preset]   BLOCKED: directory "${dir}" outside allowed prefixes`);
      continue;
    }
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      console.log(`[Preset]   mkdir ${dir}`);
    }
  }

  // Copy declared files: read from template source, write to dest
  const presetDir = join(TEMPLATES_DIR, presetId);
  for (const file of manifest.files) {
    const dest = rewritePath(file.dest);
    // Validate destination path
    if (!isAllowedDestPath(dest)) {
      console.warn(`[Preset]   BLOCKED: dest path "${dest}" outside allowed prefixes`);
      continue;
    }

    const srcPath = join(presetDir, file.src);

    // Validate source path stays within TEMPLATES_DIR
    const resolvedSrc = resolve(srcPath);
    if (!resolvedSrc.startsWith(TEMPLATES_DIR + '/') && resolvedSrc !== TEMPLATES_DIR) {
      console.warn(`[Preset]   BLOCKED: src path "${file.src}" resolves outside templates directory`);
      continue;
    }

    if (!existsSync(srcPath)) {
      console.warn(`[Preset]   SKIP ${file.src} (source not found)`);
      continue;
    }

    // Ensure destination directory exists
    const destDir = dirname(dest);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }

    // Write file (don't overwrite user edits for data files, unless force)
    const isDataFile = dest.includes('/memory/') || dest.endsWith('preferences.md') || dest.includes('/rules/user/');
    if (!force && file.skipIfExists && existsSync(dest)) {
      console.log(`[Preset]   KEEP ${dest} (skipIfExists)`);
    } else if (!force && isDataFile && existsSync(dest)) {
      console.log(`[Preset]   KEEP ${dest} (user data exists)`);
    } else {
      // Backup data files before force-overwrite
      if (force && isDataFile && existsSync(dest)) {
        backupFile(dest);
      }
      let fileContent = readFileSync(srcPath, 'utf-8');
      // For markdown files: rewrite template placeholders to actual runtime paths.
      // This allows a single template to work correctly across Docker (/workspace/)
      // and non-Docker deployments (e.g. /home/codeck/workspace/).
      if (dest.endsWith('.md') && (WORKSPACE !== '/workspace' || home !== '/root')) {
        fileContent = fileContent
          .replace(/\/workspace\//g, `${WORKSPACE}/`)
          .replace(/\/workspace(?=\s|$|['"`,)])/g, WORKSPACE)
          .replace(/\/root\//g, `${home}/`);
      }
      writeFileSync(dest, fileContent);
      console.log(`[Preset]   WRITE ${dest}`);
    }
  }

  // Merge preset hooks into existing settings.json (additive-only).
  // settings.json uses skipIfExists to protect user permissions, but that means
  // new hooks added in preset updates never reach existing users. This merge
  // adds missing preset-managed hooks (identified by /workspace/.codeck/scripts/ path)
  // without touching user permissions, model settings, or custom hooks.
  mergePresetHooks(presetDir);

  // Copy recursive directories declared in the manifest
  if (manifest.recursive_dirs && manifest.recursive_dirs.length > 0) {
    console.log(`[Preset] Copying recursive directories for "${manifest.id}"...`);
    for (const rd of manifest.recursive_dirs) {
      const srcDir = join(presetDir, rd.src);
      const destDir = rewritePath(rd.dest);

      // Validate destination
      if (!isAllowedDestPath(destDir)) {
        console.warn(`[Preset]   BLOCKED: recursive_dirs dest "${destDir}" outside allowed prefixes`);
        continue;
      }

      // Validate source path
      const resolvedSrc = resolve(srcDir);
      if (!resolvedSrc.startsWith(TEMPLATES_DIR + '/') && resolvedSrc !== TEMPLATES_DIR) {
        console.warn(`[Preset]   BLOCKED: recursive_dirs src "${rd.src}" resolves outside templates directory`);
        continue;
      }

      copyDirectoryRecursive(srcDir, destDir, manifest.id, { skipIfExists: rd.skipIfExists });
    }
  }

  // Write config.json (only for the top-level preset, not parents)
  // Read-merge-write to preserve other keys (e.g. permissions)
  if (!existsSync(WORKSPACE_CODECK)) {
    mkdirSync(WORKSPACE_CODECK, { recursive: true, mode: 0o700 });
  }
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed;
      }
    }
  } catch { /* start fresh */ }
  existing.presetId = manifest.id;
  existing.presetName = manifest.name;
  existing.configuredAt = new Date().toISOString();
  existing.version = manifest.version;
  writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
  console.log(`[Preset] ✓ "${manifest.id}" applied. Config written to ${CONFIG_FILE}`);
}

function loadManifest(presetId: string): PresetManifest | null {
  // Validate presetId to prevent path traversal
  if (!isValidPresetId(presetId)) {
    console.warn(`[Preset] Invalid preset ID: "${presetId}"`);
    return null;
  }

  const manifestPath = join(TEMPLATES_DIR, presetId, 'manifest.json');

  // Double-check resolved path stays within TEMPLATES_DIR
  const resolvedPath = resolve(manifestPath);
  if (!resolvedPath.startsWith(TEMPLATES_DIR + '/')) {
    console.warn(`[Preset] Path traversal blocked for preset ID: "${presetId}"`);
    return null;
  }

  if (!existsSync(manifestPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const manifest = validateManifest(raw);
    if (!manifest) {
      console.warn(`[Preset] Invalid manifest schema for preset "${presetId}"`);
      return null;
    }
    return manifest;
  } catch (e) {
    console.warn(`[Preset] Failed to load manifest "${presetId}":`, (e as Error).message);
    return null;
  }
}

/**
 * Recursively copy a directory from srcDir (within TEMPLATES_DIR) to destDir.
 * - Respects skipIfExists: skips files that already exist at the destination.
 * - Applies path rewriting to .md files (same as individual file copy).
 * - Validates all destination paths stay within ALLOWED_DEST_PREFIXES.
 */
function copyDirectoryRecursive(
  srcDir: string,
  destDir: string,
  presetId: string,
  opts: { skipIfExists: boolean },
): void {
  // Validate source path stays within TEMPLATES_DIR
  const resolvedSrc = resolve(srcDir);
  if (!resolvedSrc.startsWith(TEMPLATES_DIR + '/') && resolvedSrc !== TEMPLATES_DIR) {
    console.warn(`[Preset]   BLOCKED: recursive src "${srcDir}" resolves outside templates directory`);
    return;
  }

  if (!existsSync(srcDir)) {
    console.warn(`[Preset]   SKIP recursive copy: source dir not found: ${srcDir}`);
    return;
  }

  // Validate destination
  if (!isAllowedDestPath(destDir)) {
    console.warn(`[Preset]   BLOCKED: recursive dest "${destDir}" outside allowed prefixes`);
    return;
  }

  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  for (const entry of readdirSync(srcDir)) {
    const srcEntry = join(srcDir, entry);
    const destEntry = join(destDir, entry);

    const stat = statSync(srcEntry);
    if (stat.isDirectory()) {
      copyDirectoryRecursive(srcEntry, destEntry, presetId, opts);
    } else {
      if (opts.skipIfExists && existsSync(destEntry)) {
        console.log(`[Preset]   KEEP ${destEntry} (skipIfExists)`);
        continue;
      }

      // Ensure destination parent directory exists
      const destEntryDir = dirname(destEntry);
      if (!existsSync(destEntryDir)) {
        mkdirSync(destEntryDir, { recursive: true });
      }

      let fileContent = readFileSync(srcEntry, 'utf-8');
      // Rewrite template paths in .md files
      if (destEntry.endsWith('.md') && (WORKSPACE !== '/workspace' || home !== '/root')) {
        fileContent = fileContent
          .replace(/\/workspace\//g, `${WORKSPACE}/`)
          .replace(/\/workspace(?=\s|$|['"`,)])/g, WORKSPACE)
          .replace(/\/root\//g, `${home}/`);
      }
      writeFileSync(destEntry, fileContent);
      console.log(`[Preset]   WRITE ${destEntry}`);
    }
  }
}

/** Create a timestamped backup of a file before overwriting. */
function backupFile(filePath: string): void {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = join(BACKUPS_DIR, timestamp);
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true });
    }
    const fileName = filePath.replace(/\//g, '__');
    copyFileSync(filePath, join(backupDir, fileName));
    console.log(`[Preset]   BACKUP ${filePath} → ${backupDir}/${fileName}`);
  } catch (e) {
    console.warn(`[Preset]   Failed to backup ${filePath}:`, (e as Error).message);
  }
}
