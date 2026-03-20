import { Router } from 'express';
import { readdir, stat, readFile, writeFile, realpath, access } from 'fs/promises';
import { join, resolve, sep } from 'path';

const WORKSPACE = resolve(process.env.WORKSPACE || '/workspace');
const AGENT_DATA_DIR = join(WORKSPACE, '.codeck');
const router = Router();

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

export default router;
