/**
 * FTS5-based search service for memory files.
 * Depends on memory-indexer being initialized.
 */

import type Database from 'better-sqlite3';
import { join } from 'path';
import { PATHS } from './memory.js';
import { embed, isEmbeddingsAvailable } from './embeddings.js';
import { isVecAvailable } from './memory-indexer.js';

const DB_PATH = join(PATHS.INDEX_DIR, 'memory.sqlite');

let db: Database.Database | null = null;
let available = false;

export interface SearchResult {
  content: string;
  filePath: string;
  fileType: string;
  metadata: Record<string, unknown>;
  rank: number;
  snippet: string;
}

export interface SearchOptions {
  query: string;
  scope?: string[];
  project?: string;
  pathId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export async function initializeSearch(): Promise<boolean> {
  try {
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    db = new BetterSqlite3(DB_PATH, { readonly: true });
    available = true;
    console.log('[Search] FTS5 search ready');
    return true;
  } catch (e) {
    console.log('[Search] Not available:', (e as Error).message);
    available = false;
    return false;
  }
}

export function shutdownSearch(): void {
  if (db) {
    db.close();
    db = null;
  }
  available = false;
}

export function isSearchAvailable(): boolean {
  return available;
}

export function search(options: SearchOptions): SearchResult[] {
  if (!db) return [];

  const { query, scope, project, pathId, dateFrom, dateTo, limit = 20 } = options;

  if (!query.trim()) return [];

  // Sanitize FTS5 query: double embedded quotes, wrap each term for prefix matching
  const MAX_TERMS = 50;
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length > MAX_TERMS) {
    console.log(`[Search] Query truncated: ${terms.length} terms → ${MAX_TERMS}`);
    terms.length = MAX_TERMS;
  }
  const ftsQuery = terms
    .map(term => `"${term.replace(/"/g, '""')}"*`)
    .join(' ');

  let sql = `
    SELECT
      c.content,
      f.path AS filePath,
      f.type AS fileType,
      c.metadata,
      bm25(chunks_fts) AS rank,
      snippet(chunks_fts, 0, '<mark>', '</mark>', '...', 40) AS snippet
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN files f ON f.id = c.file_id
    WHERE chunks_fts MATCH ?
  `;

  const params: unknown[] = [ftsQuery];

  if (scope && scope.length > 0) {
    const placeholders = scope.map(() => '?').join(',');
    sql += ` AND f.type IN (${placeholders})`;
    params.push(...scope);
  }

  if (pathId) {
    sql += ` AND f.path LIKE ?`;
    params.push(`paths/${pathId}/%`);
  }

  if (project) {
    sql += ` AND json_extract(c.metadata, '$.project') = ?`;
    params.push(project);
  }

  if (dateFrom) {
    sql += ` AND json_extract(c.metadata, '$.date') >= ?`;
    params.push(dateFrom);
  }

  if (dateTo) {
    sql += ` AND json_extract(c.metadata, '$.date') <= ?`;
    params.push(dateTo);
  }

  sql += ` ORDER BY rank LIMIT ?`;
  params.push(limit);

  try {
    const rows = db.prepare(sql).all(...params) as Array<{
      content: string;
      filePath: string;
      fileType: string;
      metadata: string;
      rank: number;
      snippet: string;
    }>;

    return rows.map(row => ({
      content: row.content,
      filePath: row.filePath,
      fileType: row.fileType,
      metadata: safeJsonParse(row.metadata),
      rank: row.rank,
      snippet: row.snippet,
    }));
  } catch (e) {
    console.log('[Search] Query error:', (e as Error).message);
    return [];
  }
}

/**
 * Vector similarity search using sqlite-vec.
 */
export async function vectorSearch(options: SearchOptions): Promise<SearchResult[]> {
  if (!db || !isVecAvailable() || !isEmbeddingsAvailable()) return [];

  const { query, limit = 20 } = options;
  if (!query.trim()) return [];

  const queryVec = await embed(query);
  if (!queryVec) return [];

  try {
    const sql = `
      SELECT
        c.content,
        f.path AS filePath,
        f.type AS fileType,
        c.metadata,
        v.distance AS rank
      FROM chunks_vec v
      JOIN chunks c ON c.id = v.chunk_id
      JOIN files f ON f.id = c.file_id
      WHERE v.embedding MATCH ?
      ORDER BY v.distance
      LIMIT ?
    `;

    const rows = db.prepare(sql).all(Buffer.from(queryVec.buffer), limit) as Array<{
      content: string;
      filePath: string;
      fileType: string;
      metadata: string;
      rank: number;
    }>;

    return rows.map(row => ({
      content: row.content,
      filePath: row.filePath,
      fileType: row.fileType,
      metadata: safeJsonParse(row.metadata),
      rank: row.rank,
      snippet: row.content.slice(0, 200),
    }));
  } catch (e) {
    console.log('[Search] Vector search error:', (e as Error).message);
    return [];
  }
}

/**
 * Hybrid search: runs BM25 + vector search in parallel, merges with
 * Reciprocal Rank Fusion (RRF).
 */
export async function hybridSearch(options: SearchOptions): Promise<SearchResult[]> {
  const useVec = isVecAvailable() && isEmbeddingsAvailable();

  if (!useVec) {
    // Fallback to BM25 only
    return search(options);
  }

  const limit = options.limit || 20;

  // Run both searches in parallel
  const [bm25Results, vecResults] = await Promise.all([
    Promise.resolve(search({ ...options, limit: limit * 2 })),
    vectorSearch({ ...options, limit: limit * 2 }),
  ]);

  // Reciprocal Rank Fusion
  const k = 60; // RRF constant
  const scores = new Map<string, { score: number; result: SearchResult }>();

  const makeKey = (r: SearchResult) => `${r.filePath}:${r.content.slice(0, 50)}`;

  for (let i = 0; i < bm25Results.length; i++) {
    const key = makeKey(bm25Results[i]);
    const existing = scores.get(key);
    const bm25Score = 0.4 / (k + i + 1);
    if (existing) {
      existing.score += bm25Score;
    } else {
      scores.set(key, { score: bm25Score, result: bm25Results[i] });
    }
  }

  for (let i = 0; i < vecResults.length; i++) {
    const key = makeKey(vecResults[i]);
    const existing = scores.get(key);
    const vecScore = 0.6 / (k + i + 1);
    if (existing) {
      existing.score += vecScore;
    } else {
      scores.set(key, { score: vecScore, result: vecResults[i] });
    }
  }

  // Sort by RRF score descending and take top N
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, result }) => ({ ...result, rank: score }));
}

function safeJsonParse(str: string): Record<string, unknown> {
  try { return JSON.parse(str); } catch { return {}; }
}
