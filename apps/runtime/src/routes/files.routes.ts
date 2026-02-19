import { Router } from 'express';
import { readdir, stat, readFile, writeFile, mkdir } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { broadcastStatus } from '../web/websocket.js';

// Resolve WORKSPACE to absolute path at startup for consistent path traversal checks
const WORKSPACE = resolve(process.env.WORKSPACE || '/workspace');
const router = Router();

/**
 * Resolve a relative path against a base directory and validate it stays within bounds.
 * Returns the validated path, or null if access is denied.
 *
 * Path traversal is prevented by resolving ".." segments and checking the result
 * starts with the base directory. Symlinks within the workspace are intentionally
 * followed — they are placed by the admin (e.g., repo symlinks for self-dev).
 */
async function safePath(base: string, relativePath: string): Promise<string | null> {
  const resolved = resolve(base, relativePath);
  if (!resolved.startsWith(base + sep) && resolved !== base) return null;
  return resolved;
}

// List directory files
router.get('/', async (req, res) => {
  const relativePath = (req.query.path || '') as string;
  const fullPath = await safePath(WORKSPACE, relativePath);

  if (!fullPath) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  try {
    const entries = await readdir(fullPath);
    const items = await Promise.all(
      entries
        .filter(name => !name.startsWith('.'))
        .map(async name => {
          const itemPath = join(fullPath, name);
          try {
            const s = await stat(itemPath);
            return {
              name,
              isDirectory: s.isDirectory(),
              size: s.size,
              modified: s.mtime,
            };
          } catch {
            return { name, isDirectory: false, size: 0 };
          }
        })
    );

    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ success: true, path: relativePath, items });
  } catch {
    res.status(404).json({ error: 'Directory not found' });
  }
});

// Read file content (text only, limited to 100KB)
router.get('/read', async (req, res) => {
  const relativePath = req.query.path as string;
  if (!relativePath) {
    res.status(400).json({ error: 'Path required' });
    return;
  }

  const fullPath = await safePath(WORKSPACE, relativePath);

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

// Write file content (text only, limited to 500KB)
router.put('/write', async (req, res) => {
  const { path: relativePath, content } = req.body;
  if (!relativePath || typeof relativePath !== 'string') {
    res.status(400).json({ error: 'Path required' });
    return;
  }
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'Content required' });
    return;
  }
  if (content.length > 500 * 1024) {
    res.status(400).json({ error: 'Content too large (max 500KB)' });
    return;
  }

  const fullPath = await safePath(WORKSPACE, relativePath);

  if (!fullPath) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  try {
    // Write directly — handle ENOENT to report missing parent directory
    await writeFile(fullPath, content, 'utf-8');
    res.json({ success: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      res.status(404).json({ error: 'Parent directory does not exist' });
    } else {
      res.status(500).json({ error: 'Error writing file' });
    }
  }
});

// Create directory
router.post('/mkdir', async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name required' });
    return;
  }

  // Sanitize: only allow alphanumeric, dash, underscore, dot (no leading dot)
  const sanitized = name.replace(/[^a-zA-Z0-9_\-. ]/g, '').replace(/^\.+/, '').trim();
  if (!sanitized || sanitized.length > 100) {
    res.status(400).json({ error: 'Invalid name' });
    return;
  }

  const fullPath = await safePath(WORKSPACE, sanitized);

  if (!fullPath) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  try {
    // Atomic: mkdir with recursive:false throws EEXIST if directory exists
    await mkdir(fullPath, { recursive: false });
    broadcastStatus();
    res.json({ success: true, name: sanitized, path: '/workspace/' + sanitized });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      res.status(409).json({ error: 'Already exists' });
    } else {
      res.status(500).json({ error: 'Error creating directory' });
    }
  }
});

export default router;
