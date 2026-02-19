/**
 * SQLite FTS5 indexer for memory files.
 *
 * Uses better-sqlite3 (native module, optional dependency).
 * Gracefully degrades if the module is not available (e.g. Windows dev).
 */

import { existsSync, readFileSync, readdirSync, statSync, watch, mkdirSync } from 'fs';
import { join, relative, extname } from 'path';
import { createHash } from 'crypto';
import { sanitizeSecrets } from './session-writer.js';
import type Database from 'better-sqlite3';
import { PATHS } from './memory.js';
import { embed, isEmbeddingsAvailable, getEmbeddingDim } from './embeddings.js';

const DB_PATH = join(PATHS.INDEX_DIR, 'memory.sqlite');

let db: Database.Database | null = null;
let watchers: ReturnType<typeof watch>[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const pendingPaths = new Set<string>();
let available = false;
let vecAvailable = false;
let reindexInProgress = false;

// Queue for async embedding indexing (processed after file indexing)
const embeddingQueue: { chunkId: number; content: string }[] = [];

// ── Schema ──

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  hash TEXT NOT NULL,
  indexed_at INTEGER NOT NULL,
  size INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  UNIQUE(file_id, chunk_index)
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content, metadata,
  content=chunks, content_rowid=id,
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content, metadata) VALUES (new.id, new.content, new.metadata);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, metadata) VALUES('delete', old.id, old.content, old.metadata);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, metadata) VALUES('delete', old.id, old.content, old.metadata);
  INSERT INTO chunks_fts(rowid, content, metadata) VALUES (new.id, new.content, new.metadata);
END;
`;

// ── Initialization ──

export async function initializeIndexer(): Promise<boolean> {
  try {
    if (!existsSync(PATHS.INDEX_DIR)) mkdirSync(PATHS.INDEX_DIR, { recursive: true });
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    db = new BetterSqlite3(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    available = true;
    console.log('[Indexer] SQLite FTS5 initialized at', DB_PATH);

    // Try loading sqlite-vec extension for vector search
    try {
      // Dynamic import — optional dependency, only available in Docker
      const sqliteVec = await (Function('return import("sqlite-vec")')() as Promise<any>);
      sqliteVec.load(db);
      const dim = getEmbeddingDim();
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
          chunk_id INTEGER PRIMARY KEY,
          embedding FLOAT[${dim}]
        );
      `);
      vecAvailable = true;
      console.log(`[Indexer] sqlite-vec loaded (${dim}d vectors)`);
    } catch (e) {
      console.log('[Indexer] sqlite-vec not available (vector search disabled):', (e as Error).message);
    }

    // Initial full index
    indexAll();

    // Start file watchers
    startWatchers();

    return true;
  } catch (e) {
    console.log('[Indexer] SQLite not available (expected on Windows dev):', (e as Error).message);
    available = false;
    return false;
  }
}

export function shutdownIndexer(): void {
  for (const w of watchers) w.close();
  watchers = [];
  if (db) {
    db.close();
    db = null;
  }
  available = false;
  console.log('[Indexer] Shut down');
}

export function isIndexerAvailable(): boolean {
  return available;
}

// ── File hashing ──

function fileHash(path: string): string {
  const content = readFileSync(path);
  return createHash('sha256').update(content).digest('hex');
}

// ── Chunking ──

function chunkMarkdown(content: string, meta: Record<string, unknown>): { content: string; metadata: string }[] {
  const chunks: { content: string; metadata: string }[] = [];
  const sections = content.split(/(?=^#{1,3} )/m);

  let buffer = '';
  let heading = '';

  for (const section of sections) {
    const headingMatch = section.match(/^(#{1,3}) (.+)/);
    if (headingMatch) heading = headingMatch[2].trim();

    if (buffer.length + section.length > 1600 && buffer.length > 0) {
      chunks.push({
        content: buffer.trim(),
        metadata: JSON.stringify({ ...meta, heading }),
      });
      // Overlap: keep last 320 chars
      buffer = buffer.slice(-320) + section;
    } else {
      buffer += section;
    }
  }

  if (buffer.trim()) {
    chunks.push({
      content: buffer.trim(),
      metadata: JSON.stringify({ ...meta, heading }),
    });
  }

  return chunks.length > 0 ? chunks : [{ content: content.trim(), metadata: JSON.stringify(meta) }];
}

function chunkJsonl(content: string, meta: Record<string, unknown>): { content: string; metadata: string }[] {
  const lines = content.split('\n').filter(Boolean);
  const chunks: { content: string; metadata: string }[] = [];
  const chunkSize = 20;

  for (let i = 0; i < lines.length; i += chunkSize) {
    const group = lines.slice(i, i + chunkSize);
    const roles = new Set<string>();
    let firstTs = 0;
    let lastTs = 0;
    for (const line of group) {
      try {
        const obj = JSON.parse(line);
        if (obj.role) roles.add(obj.role);
        if (obj.ts) {
          if (!firstTs) firstTs = obj.ts;
          lastTs = obj.ts;
        }
      } catch { /* skip */ }
    }

    chunks.push({
      content: group.join('\n'),
      metadata: JSON.stringify({ ...meta, roles: Array.from(roles), firstTs, lastTs }),
    });
  }

  return chunks;
}

// ── File type detection ──
// Files can be in MEMORY_DIR (durable, daily, decisions, paths) or SESSIONS_DIR

function getFileType(filepath: string): string {
  // Check sessions dir first (it's outside memory dir)
  if (filepath.startsWith(PATHS.SESSIONS_DIR)) return 'session';

  const rel = relative(PATHS.MEMORY_DIR, filepath);
  if (rel === 'MEMORY.md' || rel === 'summary.md') return 'durable';
  if (rel.startsWith('daily/') || rel.startsWith('daily\\')) return 'daily';
  if ((rel.startsWith('decisions/') || rel.startsWith('decisions\\')) || rel === 'decisions.md') return 'decision';
  if (rel.startsWith('paths/') || rel.startsWith('paths\\')) {
    // Check if it's a path-scoped daily or durable
    if (rel.includes('/daily/') || rel.includes('\\daily\\')) return 'path-daily';
    if (rel.endsWith('MEMORY.md')) return 'path';
    return 'path';
  }
  // Legacy
  if (rel.startsWith('journal/') || rel.startsWith('journal\\')) return 'daily';
  if (rel.startsWith('projects/') || rel.startsWith('projects\\')) return 'project';
  return 'other';
}

// Compute relative path for DB storage (normalizes both memory and session files)
function getRelPath(filepath: string): string {
  if (filepath.startsWith(PATHS.SESSIONS_DIR)) {
    return 'sessions/' + relative(PATHS.SESSIONS_DIR, filepath).replace(/\\/g, '/');
  }
  return relative(PATHS.MEMORY_DIR, filepath).replace(/\\/g, '/');
}

// ── Indexing ──

function indexFile(filepath: string): void {
  if (!db) return;

  const ext = extname(filepath);
  if (ext !== '.md' && ext !== '.jsonl') return;

  const hash = fileHash(filepath);
  const stat = statSync(filepath);
  const type = getFileType(filepath);
  const relPath = getRelPath(filepath);

  // Check if already indexed with same hash
  const existing = db.prepare('SELECT id, hash FROM files WHERE path = ?').get(relPath) as { id: number; hash: string } | undefined;
  if (existing && existing.hash === hash) return;

  const content = sanitizeSecrets(readFileSync(filepath, 'utf-8'));
  const meta: Record<string, unknown> = { type, path: relPath };

  // Extract date from daily filenames
  if (type === 'daily' || type === 'path-daily') {
    const dateMatch = relPath.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) meta.date = dateMatch[1];
  }

  const chunks = ext === '.jsonl'
    ? chunkJsonl(content, meta)
    : chunkMarkdown(content, meta);

  // Transaction: delete old, insert new
  const transaction = db.transaction(() => {
    if (existing) {
      db!.prepare('DELETE FROM chunks WHERE file_id = ?').run(existing.id);
      db!.prepare('DELETE FROM files WHERE id = ?').run(existing.id);
    }

    const insertFile = db!.prepare(
      'INSERT INTO files (path, type, hash, indexed_at, size) VALUES (?, ?, ?, ?, ?)'
    );
    const result = insertFile.run(relPath, type, hash, Date.now(), stat.size);
    const fileId = result.lastInsertRowid;

    const insertChunk = db!.prepare(
      'INSERT INTO chunks (file_id, chunk_index, content, metadata) VALUES (?, ?, ?, ?)'
    );

    // Also clear old vec entries if vec is available
    if (vecAvailable && existing) {
      try {
        // Get old chunk IDs for this file to remove from vec table
        const oldChunks = db!.prepare('SELECT id FROM chunks WHERE file_id = ?').all(existing.id) as { id: number }[];
        const deleteVec = db!.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?');
        for (const c of oldChunks) {
          deleteVec.run(c.id);
        }
      } catch { /* vec table may not exist yet */ }
    }

    for (let i = 0; i < chunks.length; i++) {
      const result = insertChunk.run(fileId, i, chunks[i].content, chunks[i].metadata);
      // Queue for async embedding
      if (vecAvailable && isEmbeddingsAvailable()) {
        embeddingQueue.push({ chunkId: Number(result.lastInsertRowid), content: chunks[i].content });
      }
    }
  });

  transaction();
}

function scanDirectory(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...scanDirectory(fullPath));
    } else if (entry.name.endsWith('.md') || entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }

  return files;
}

export function indexAll(): { success: boolean; reason?: string } {
  if (!db) return { success: false, reason: 'Indexer not available' };
  if (reindexInProgress) return { success: false, reason: 'Reindex already in progress' };

  reindexInProgress = true;
  try {
    return _indexAllInner();
  } finally {
    reindexInProgress = false;
  }
}

function _indexAllInner(): { success: boolean } {
  if (!db) return { success: false };

  // Scan both memory dir and sessions dir
  const files = [
    ...scanDirectory(PATHS.MEMORY_DIR),
    ...scanDirectory(PATHS.SESSIONS_DIR),
  ];
  let indexed = 0;

  for (const filepath of files) {
    try {
      indexFile(filepath);
      indexed++;
    } catch (e) {
      console.log(`[Indexer] Error indexing ${filepath}:`, (e as Error).message);
    }
  }

  // Clean up entries for deleted files
  const allPaths = db.prepare('SELECT id, path FROM files').all() as { id: number; path: string }[];
  for (const row of allPaths) {
    // Resolve relative path back to absolute
    const fullPath = row.path.startsWith('sessions/')
      ? join(PATHS.SESSIONS_DIR, row.path.replace(/^sessions\//, ''))
      : join(PATHS.MEMORY_DIR, row.path);
    if (!existsSync(fullPath)) {
      db.prepare('DELETE FROM chunks WHERE file_id = ?').run(row.id);
      db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
    }
  }

  // FTS5 optimize: merge all index segments into one for faster queries.
  // This can be CPU/IO-intensive for large indexes and may cause 2-3 second
  // latency spikes for concurrent search queries via the read-only connection.
  // WAL mode ensures queries still return correct results during this operation.
  try {
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')");
  } catch (e) {
    console.log('[Indexer] FTS5 optimize failed:', (e as Error).message);
  }

  console.log(`[Indexer] Indexed ${indexed} files`);

  // Kick off async embedding processing if there are queued chunks
  if (embeddingQueue.length > 0) {
    setImmediate(() => processEmbeddingQueue());
  }

  return { success: true };
}

// ── File watchers ──

function startWatchers(): void {
  for (const w of watchers) w.close();
  watchers = [];

  const dirsToWatch = [PATHS.MEMORY_DIR, PATHS.SESSIONS_DIR];

  for (const dir of dirsToWatch) {
    if (!existsSync(dir)) continue;
    try {
      const w = watch(dir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (filename.includes('.sqlite')) return;

        // Queue changed path and debounce: process ALL queued files after 2s of quiet
        pendingPaths.add(join(dir, filename));
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const paths = [...pendingPaths];
          pendingPaths.clear();
          for (const fullPath of paths) {
            try {
              indexFile(fullPath);
            } catch (e) {
              const code = (e as NodeJS.ErrnoException).code;
              if (code === 'ENOENT') {
                // File deleted between watch event and index attempt — clean up
                if (db) {
                  const relPath = getRelPath(fullPath);
                  const row = db.prepare('SELECT id FROM files WHERE path = ?').get(relPath) as { id: number } | undefined;
                  if (row) {
                    db.prepare('DELETE FROM chunks WHERE file_id = ?').run(row.id);
                    db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
                  }
                }
              } else {
                console.log('[Indexer] Re-index error:', (e as Error).message);
              }
            }
          }
        }, 2000);
      });
      watchers.push(w);
    } catch (e) {
      console.log(`[Indexer] Could not watch ${dir}:`, (e as Error).message);
    }
  }

  if (watchers.length > 0) console.log(`[Indexer] File watchers started (${watchers.length} dirs)`);
}

// ── Embedding queue processing ──

/**
 * Process queued chunks for embedding indexing.
 * Called after indexAll() or on a timer. Async because embedding is slow.
 */
export async function processEmbeddingQueue(): Promise<number> {
  if (!db || !vecAvailable || embeddingQueue.length === 0) return 0;

  const batch = embeddingQueue.splice(0, 50); // Process up to 50 at a time
  let indexed = 0;

  const insertVec = db.prepare('INSERT OR REPLACE INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)');

  for (const item of batch) {
    try {
      const vec = await embed(item.content);
      if (vec) {
        insertVec.run(item.chunkId, Buffer.from(vec.buffer));
        indexed++;
      }
    } catch (e) {
      console.log('[Indexer] Embedding error for chunk', item.chunkId, ':', (e as Error).message);
    }
  }

  if (indexed > 0) {
    console.log(`[Indexer] Embedded ${indexed}/${batch.length} chunks (${embeddingQueue.length} remaining)`);
  }

  // Schedule next batch if more remain
  if (embeddingQueue.length > 0) {
    setTimeout(() => processEmbeddingQueue(), 100);
  }

  return indexed;
}

export function isVecAvailable(): boolean {
  return vecAvailable && isEmbeddingsAvailable();
}

export function getEmbeddingQueueSize(): number {
  return embeddingQueue.length;
}

// ── Stats ──

export function getIndexStats(): Record<string, unknown> {
  if (!db) return { available: false };

  const fileCount = (db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }).c;
  const chunkCount = (db.prepare('SELECT COUNT(*) as c FROM chunks').get() as { c: number }).c;
  const typeCounts = db.prepare('SELECT type, COUNT(*) as c FROM files GROUP BY type').all() as { type: string; c: number }[];

  let vecCount = 0;
  if (vecAvailable) {
    try {
      vecCount = (db.prepare('SELECT COUNT(*) as c FROM chunks_vec').get() as { c: number }).c;
    } catch { /* vec table may not exist */ }
  }

  return {
    available: true,
    fileCount,
    chunkCount,
    vecCount,
    vecAvailable,
    embeddingQueueSize: embeddingQueue.length,
    typeCounts: Object.fromEntries(typeCounts.map(t => [t.type, t.c])),
    dbPath: DB_PATH,
  };
}
