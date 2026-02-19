import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, realpathSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODECK_DIR = process.env.CODECK_DIR || '/workspace/.codeck';
const CONFIG_FILE = join(CODECK_DIR, 'config.json');
const TEMPLATES_DIR = resolve(join(__dirname, '../templates/presets'));
const BACKUPS_DIR = join(CODECK_DIR, 'backups');

// Strict allowlist for preset IDs: alphanumeric, hyphens, underscores only
const VALID_PRESET_ID = /^[a-zA-Z0-9_-]+$/;

const home = process.env.HOME || '/root';
const WORKSPACE = process.env.WORKSPACE || '/workspace';

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

export interface PresetManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  icon: string;
  tags: string[];
  extends: string | null;
  files: Array<{ src: string; dest: string }>;
  directories: string[];
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
  }
  if (!Array.isArray(m.directories)) return null;
  for (const d of m.directories) {
    if (typeof d !== 'string') return null;
  }
  return data as PresetManifest;
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
  if (!existsSync(CONFIG_FILE)) {
    return { configured: false, presetId: null, presetName: null, configuredAt: null, version: null };
  }
  try {
    const config: PresetConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    return {
      configured: true,
      presetId: config.presetId,
      presetName: config.presetName,
      configuredAt: config.configuredAt,
      version: config.version,
    };
  } catch (e) {
    console.warn('[Preset] Failed to read config:', (e as Error).message);
    return { configured: false, presetId: null, presetName: null, configuredAt: null, version: null };
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

async function applyPresetRecursive(presetId: string, visited: Set<string>, depth: number, force: boolean): Promise<void> {
  if (depth > 5) {
    throw new Error(`Preset extends chain too deep (>5). Possible circular reference.`);
  }
  if (visited.has(presetId)) {
    throw new Error(`Circular preset extends detected: "${presetId}" already applied in this chain.`);
  }
  visited.add(presetId);

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
    const isDataFile = dest.includes('/memory/') || dest.endsWith('preferences.md') || dest.includes('/rules/');
    if (!force && isDataFile && existsSync(dest)) {
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

  // Write config.json (only for the top-level preset, not parents)
  // We write it after every apply since the last one in the chain is the "active" preset
  const config: PresetConfig = {
    presetId: manifest.id,
    presetName: manifest.name,
    configuredAt: new Date().toISOString(),
    version: manifest.version,
  };

  // Ensure /workspace/.codeck/ exists for config.json
  if (!existsSync(CODECK_DIR)) {
    mkdirSync(CODECK_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
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
