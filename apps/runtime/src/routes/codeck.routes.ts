import { Router } from 'express';
import { readdir, stat, readFile, writeFile, realpath, access, mkdir, rm } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync, createReadStream, readFileSync, writeFileSync } from 'fs';

const execFileAsync = promisify(execFile);

const WORKSPACE = resolve(process.env.WORKSPACE || '/workspace');
const AGENT_DATA_DIR = join(WORKSPACE, '.codeck');
const CLAUDE_JSON_PATH = join(process.env.HOME || '/root', '.claude.json');
const router = Router();

/**
 * Sync an env var value into MCP server configs in .claude.json.
 * When a user saves e.g. SUPABASE_ACCESS_TOKEN=xxx, we need to update
 * the matching env field in mcpServers (or _disabledMcpServers) so
 * Claude Code can pass it to the MCP subprocess on start.
 */
function syncEnvToMcpServers(key: string, value: string | null): void {
  try {
    const raw = readFileSync(CLAUDE_JSON_PATH, 'utf-8');
    const config = JSON.parse(raw);
    let changed = false;

    for (const section of ['mcpServers', '_disabledMcpServers']) {
      const servers = config[section];
      if (!servers || typeof servers !== 'object') continue;
      for (const serverConfig of Object.values(servers) as Array<{ env?: Record<string, string> }>) {
        if (serverConfig.env && key in serverConfig.env) {
          serverConfig.env[key] = value ?? '';
          changed = true;
        }
      }
    }

    if (changed) {
      writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(config, null, 2));
    }
  } catch { /* non-fatal — .claude.json may not exist yet */ }
}

/**
 * Resolve a relative path against a base directory, validate it stays within bounds,
 * and resolve symlinks to prevent symlink-based path traversal bypasses.
 * Returns the validated path, or null if access is denied.
 */
async function safePath(base: string, relativePath: string): Promise<string | null> {
  const resolved = resolve(base, relativePath);
  if (!resolved.startsWith(base + sep) && resolved !== base) return null;
  try {
    const real = await realpath(resolved);
    if (!real.startsWith(base + sep) && real !== base) return null;
    return real;
  } catch {
    // Path doesn't exist — resolved path is acceptable
    return resolved;
  }
}

// List directory contents
router.get('/files', async (req, res) => {
  const relativePath = (req.query.path || '') as string;
  const typeFilter = req.query.type as string | undefined;
  const fullPath = await safePath(AGENT_DATA_DIR, relativePath);

  if (!fullPath) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  try {
    const entries = await readdir(fullPath, { withFileTypes: true });

    let items;
    if (typeFilter === 'dir') {
      // Fast path: only directories, no stat() calls needed
      items = entries
        .filter(e => e.isDirectory())
        .map(e => ({ name: e.name, isDirectory: true as const }));
    } else {
      // Full listing with stat for size/modified
      items = await Promise.all(
        entries.map(async e => {
          if (e.isDirectory()) {
            return { name: e.name, isDirectory: true as const, size: 0 };
          }
          const itemPath = join(fullPath, e.name);
          try {
            const s = await stat(itemPath);
            return { name: e.name, isDirectory: false as const, size: s.size, modified: s.mtime };
          } catch {
            return { name: e.name, isDirectory: false as const, size: 0 };
          }
        })
      );
    }

    // Sort dirs first
    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ success: true, path: relativePath, items });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      res.json({ success: true, path: relativePath, items: [] });
    } else {
      res.status(500).json({ error: 'Directory read failed' });
    }
  }
});

// Read file content
router.get('/files/read', async (req, res) => {
  const relativePath = req.query.path as string;
  if (!relativePath) {
    res.status(400).json({ error: 'path required' });
    return;
  }

  const fullPath = await safePath(AGENT_DATA_DIR, relativePath);

  if (!fullPath) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  try {
    const s = await stat(fullPath);
    if (s.size > 100 * 1024) {
      res.json({ success: false, error: 'File too large', size: s.size });
      return;
    }
    const content = await readFile(fullPath, 'utf-8');
    res.json({ success: true, content, size: s.size });
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

// Write/update file content (for manual edits, especially preferences.md)
router.put('/files/write', async (req, res) => {
  const { path: relativePath, content } = req.body;
  if (!relativePath || typeof content !== 'string') {
    res.status(400).json({ error: 'path and content required' });
    return;
  }

  const fullPath = await safePath(AGENT_DATA_DIR, relativePath);

  if (!fullPath) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  // Only allow writing to existing files (no creating new ones via API)
  try {
    await access(fullPath);
  } catch {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  try {
    await writeFile(fullPath, content);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Write failed' });
  }
});

// ── Environment Variables (.codeck/.env) ──

const ENV_FILE = join(AGENT_DATA_DIR, '.env');

function parseEnvFile(): Array<{ key: string; value: string }> {
  if (!existsSync(ENV_FILE)) return [];
  try {
    const content = readFileSync(ENV_FILE, 'utf-8');
    const vars: Array<{ key: string; value: string }> = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (key) vars.push({ key, value: val });
      }
    }
    return vars;
  } catch { return []; }
}

function writeEnvFile(vars: Array<{ key: string; value: string }>) {
  const content = vars.map(v => `${v.key}=${v.value}`).join('\n') + '\n';
  writeFileSync(ENV_FILE, content, { mode: 0o600 });
}

router.get('/env', (_req, res) => {
  // Return keys only — never expose values via API
  const vars = parseEnvFile();
  res.json({ vars: vars.map(v => ({ key: v.key, hasValue: v.value.length > 0 })) });
});

router.post('/env', (req, res) => {
  const { key, value } = req.body;
  if (!key || typeof key !== 'string' || !/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
    res.status(400).json({ error: 'Invalid key (use UPPER_SNAKE_CASE)' });
    return;
  }
  if (typeof value !== 'string') {
    res.status(400).json({ error: 'Value required' });
    return;
  }
  const vars = parseEnvFile();
  const existing = vars.findIndex(v => v.key === key);
  if (existing >= 0) {
    vars[existing].value = value;
  } else {
    vars.push({ key, value });
  }
  writeEnvFile(vars);
  // Sync to MCP server configs so Claude Code picks up the new value
  syncEnvToMcpServers(key, value);
  res.json({ success: true });
});

router.delete('/env', (req, res) => {
  const { key } = req.body;
  if (!key) { res.status(400).json({ error: 'Key required' }); return; }
  const vars = parseEnvFile().filter(v => v.key !== key);
  writeEnvFile(vars);
  // Clear the value in MCP configs (set to empty, don't remove the key)
  syncEnvToMcpServers(key, '');
  res.json({ success: true });
});

// ── Memory Export (tar.gz of .codeck/) ──

router.get('/export', async (_req, res) => {
  try {
    if (!existsSync(AGENT_DATA_DIR)) {
      res.status(404).json({ error: 'No memory data to export' });
      return;
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `codeck-memory-${timestamp}.tar.gz`;

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Use spawn for proper streaming (execFile buffers stdout which breaks pipes)
    const tar = spawn('tar', [
      'czf', '-',
      '--no-same-owner',
      '--exclude=./sessions',
      '--exclude=./sessions.json',
      '--exclude=./index',
      '--exclude=./uploads',
      '--exclude=./auth.json',
      '--exclude=./config.json',
      '--exclude=./daemon-sessions.json',
      '--exclude=./.codeck-oauth-token',
      '--exclude=./backups',
      '--exclude=./agents/*/executions',
      '--exclude=./.import-tmp-*',
      '--exclude=./.env',
      '-C', AGENT_DATA_DIR,
      '.',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    tar.stdout.pipe(res);
    tar.stderr.on('data', (d: Buffer) => console.warn('[Export]', d.toString().trim()));
    tar.on('error', (err) => {
      console.error('[Export] spawn error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
    });
    tar.on('close', (code) => {
      if (code !== 0 && !res.headersSent) {
        res.status(500).json({ error: `Export failed (tar exit ${code})` });
      }
    });
  } catch (err) {
    console.error('[Export] error:', (err as Error).message);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── Memory Import (tar.gz upload → replace .codeck/) ──

// Increase body limit for this endpoint (max 50MB)
router.post('/import', async (req, res) => {
  const { data } = req.body;
  if (!data || typeof data !== 'string') {
    res.status(400).json({ error: 'Base64-encoded tar.gz data required' });
    return;
  }

  const buffer = Buffer.from(data, 'base64');
  const MAX_IMPORT_SIZE = 50 * 1024 * 1024; // 50 MB
  if (buffer.length > MAX_IMPORT_SIZE) {
    res.status(400).json({ error: `Import too large (max ${MAX_IMPORT_SIZE / 1024 / 1024} MB)` });
    return;
  }

  if (buffer.length === 0) {
    res.status(400).json({ error: 'Empty data' });
    return;
  }

  // Extract to a temp directory first, then merge into .codeck/
  const tmpDir = join(AGENT_DATA_DIR, '.import-tmp-' + Date.now());
  try {
    await mkdir(tmpDir, { recursive: true });

    // Write buffer to temp file and extract
    const tmpFile = join(tmpDir, 'import.tar.gz');
    await writeFile(tmpFile, buffer);

    // Extract with tar — use spawn to handle non-zero exit from permission warnings
    await new Promise<void>((resolve, reject) => {
      const extract = spawn('tar', [
        'xzf', tmpFile, '-C', tmpDir,
        '--no-same-owner',
        '--no-same-permissions',
        '--warning=no-timestamp',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      extract.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      extract.on('error', reject);
      extract.on('close', () => {
        // Always resolve — permission warnings cause exit 2 but files ARE extracted
        if (stderr) console.warn('[Import] tar output:', stderr.slice(0, 500));
        resolve();
      });
    });

    // Remove the temp tar file
    await rm(tmpFile);

    // Strict allowlist — only import known safe directories/files.
    // Never import auth.json, config.json, sessions, .env, or unknown entries.
    const IMPORT_ALLOWLIST = new Set(['memory', 'rules', 'skills', 'preferences.md', 'ecc', 'agents', 'daily']);

    let imported = 0;
    for (const entry of await readdir(tmpDir)) {
      if (!IMPORT_ALLOWLIST.has(entry)) continue; // skip anything not in allowlist

      const src = join(tmpDir, entry);
      const dest = join(AGENT_DATA_DIR, entry);

      // Remove existing and replace
      if (existsSync(dest)) {
        await rm(dest, { recursive: true, force: true });
      }
      await execFileAsync('cp', ['-a', src, dest], { timeout: 10_000 });
      imported++;
    }

    // Cleanup temp dir
    await rm(tmpDir, { recursive: true, force: true });

    res.json({ success: true, imported, message: `Imported ${imported} items` });
  } catch (err) {
    // Cleanup on error
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    console.error('[Import] Failed:', (err as Error).message);
    res.status(500).json({ error: 'Import failed: ' + (err as Error).message });
  }
});

export default router;
