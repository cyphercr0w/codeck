/**
 * SQLite-backed observation tracking service.
 *
 * Captures individual tool usage events (not just session summaries).
 * Uses the same memory.sqlite database as the memory indexer (shared WAL).
 * Gracefully degrades if better-sqlite3 is not available.
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import type Database from "better-sqlite3";
import { PATHS } from "./memory.js";

const DB_PATH = join(PATHS.INDEX_DIR, "memory.sqlite");

let db: Database.Database | null = null;
let available = false;

// ── Types ──

export type ObservationType =
	| "feature"
	| "bugfix"
	| "discovery"
	| "decision"
	| "change";

export interface ObservationInput {
	session_id: string;
	tool: string;
	type?: ObservationType;
	title?: string;
	files?: string;
	concepts?: string;
	narrative?: string;
}

export interface Observation {
	id: number;
	session_id: string;
	tool: string;
	type: ObservationType;
	title: string | null;
	files: string | null;
	concepts: string | null;
	narrative: string | null;
	created_at: string;
	created_at_epoch: number;
}

export interface ObservationSummary {
	id: number;
	type: string;
	title: string | null;
	tool: string;
	created_at_epoch: number;
	token_estimate: number;
}

export interface ObsSearchOptions {
	query: string;
	type?: ObservationType;
	limit?: number;
	offset?: number;
}

export interface ListOptions {
	type?: ObservationType;
	limit?: number;
	offset?: number;
	since?: number;
}

export interface ObsSearchResult {
	id: number;
	type: string;
	title: string | null;
	tool: string;
	created_at_epoch: number;
	token_estimate: number;
	snippet: string;
}

export interface ObsStats {
	total: number;
	byType: Record<string, number>;
	available: boolean;
}

// ── Schema ──

const OBS_SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'change',
  title TEXT,
  files TEXT,
  concepts TEXT,
  narrative TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(type);
CREATE INDEX IF NOT EXISTS idx_obs_created ON observations(created_at_epoch DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, narrative, files, concepts,
  content=observations, content_rowid=id,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, narrative, files, concepts)
  VALUES (new.id, new.title, new.narrative, new.files, new.concepts);
END;

CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, narrative, files, concepts)
  VALUES('delete', old.id, old.title, old.narrative, old.files, old.concepts);
END;
`;

// ── Initialization ──

export async function initializeObservations(): Promise<boolean> {
	try {
		if (!existsSync(PATHS.INDEX_DIR))
			mkdirSync(PATHS.INDEX_DIR, { recursive: true });

		// Open the same database as memory-indexer (shared WAL). Read-write.
		const BetterSqlite3 = (await import("better-sqlite3")).default;
		db = new BetterSqlite3(DB_PATH);
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
		db.exec(OBS_SCHEMA);
		available = true;
		console.log("[Observations] SQLite observations table ready at", DB_PATH);
		return true;
	} catch (e) {
		console.log("[Observations] SQLite not available:", (e as Error).message);
		available = false;
		return false;
	}
}

export function shutdownObservations(): void {
	if (db) {
		db.close();
		db = null;
	}
	available = false;
	console.log("[Observations] Shut down");
}

export function isObservationsAvailable(): boolean {
	return available;
}

// ── Write ──

/**
 * Insert a new observation and return its id.
 * Returns -1 if not available.
 */
export function captureObservation(data: ObservationInput): number {
	if (!db) return -1;

	const stmt = db.prepare(`
    INSERT INTO observations (session_id, tool, type, title, files, concepts, narrative)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

	const result = stmt.run(
		data.session_id,
		data.tool,
		data.type ?? "change",
		data.title ?? null,
		data.files ?? null,
		data.concepts ?? null,
		data.narrative ?? null,
	);

	return Number(result.lastInsertRowid);
}

// ── Read ──

/**
 * Full-text search over observations. Returns compact index entries
 * suitable for progressive disclosure step 1.
 */
export function searchObservations(opts: ObsSearchOptions): ObsSearchResult[] {
	if (!db) return [];

	const { query, type, limit = 20, offset = 0 } = opts;

	if (!query.trim()) return [];

	// Sanitize FTS5 query: prefix-match each term
	const MAX_TERMS = 50;
	const terms = query.split(/\s+/).filter(Boolean);
	if (terms.length > MAX_TERMS) terms.length = MAX_TERMS;
	const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");

	let sql = `
    SELECT
      o.id,
      o.type,
      o.title,
      o.tool,
      o.created_at_epoch,
      (
        COALESCE(length(o.title), 0) +
        COALESCE(length(o.narrative), 0) +
        COALESCE(length(o.files), 0) +
        COALESCE(length(o.concepts), 0)
      ) / 4 AS token_estimate,
      snippet(observations_fts, 1, '<mark>', '</mark>', '...', 30) AS snippet
    FROM observations_fts
    JOIN observations o ON o.id = observations_fts.rowid
    WHERE observations_fts MATCH ?
  `;

	const params: unknown[] = [ftsQuery];

	if (type) {
		sql += ` AND o.type = ?`;
		params.push(type);
	}

	sql += ` ORDER BY bm25(observations_fts) LIMIT ? OFFSET ?`;
	params.push(limit, offset);

	try {
		const rows = db.prepare(sql).all(...params) as Array<{
			id: number;
			type: string;
			title: string | null;
			tool: string;
			created_at_epoch: number;
			token_estimate: number;
			snippet: string;
		}>;

		return rows.map((r) => ({
			...r,
			token_estimate: Math.max(1, r.token_estimate),
		}));
	} catch (e) {
		console.log("[Observations] Search error:", (e as Error).message);
		return [];
	}
}

/**
 * Fetch a single observation by id (full detail).
 */
export function getObservation(id: number): Observation | null {
	if (!db) return null;

	const row = db.prepare("SELECT * FROM observations WHERE id = ?").get(id) as
		| Observation
		| undefined;

	return row ?? null;
}

/**
 * Batch-fetch observations by ids (full detail).
 */
export function getObservationsByIds(ids: number[]): Observation[] {
	if (!db || ids.length === 0) return [];

	const placeholders = ids.map(() => "?").join(",");
	const rows = db
		.prepare(`SELECT * FROM observations WHERE id IN (${placeholders})`)
		.all(...ids) as Observation[];

	return rows;
}

/**
 * List recent observations in compact form.
 */
export function listObservations(opts: ListOptions = {}): ObservationSummary[] {
	if (!db) return [];

	const { type, limit = 50, offset = 0, since } = opts;

	let sql = `
    SELECT
      id,
      type,
      title,
      tool,
      created_at_epoch,
      (
        COALESCE(length(title), 0) +
        COALESCE(length(narrative), 0) +
        COALESCE(length(files), 0) +
        COALESCE(length(concepts), 0)
      ) / 4 AS token_estimate
    FROM observations
    WHERE 1=1
  `;

	const params: unknown[] = [];

	if (type) {
		sql += ` AND type = ?`;
		params.push(type);
	}

	if (since !== undefined) {
		sql += ` AND created_at_epoch >= ?`;
		params.push(since);
	}

	sql += ` ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?`;
	params.push(limit, offset);

	try {
		const rows = db.prepare(sql).all(...params) as ObservationSummary[];
		return rows.map((r) => ({
			...r,
			token_estimate: Math.max(1, r.token_estimate),
		}));
	} catch (e) {
		console.log("[Observations] List error:", (e as Error).message);
		return [];
	}
}

/**
 * Return aggregate counts by type.
 */
export function getObservationStats(): ObsStats {
	if (!db) return { total: 0, byType: {}, available: false };

	try {
		const total = (
			db.prepare("SELECT COUNT(*) as c FROM observations").get() as {
				c: number;
			}
		).c;

		const typeCounts = db
			.prepare("SELECT type, COUNT(*) as c FROM observations GROUP BY type")
			.all() as { type: string; c: number }[];

		return {
			total,
			byType: Object.fromEntries(typeCounts.map((t) => [t.type, t.c])),
			available: true,
		};
	} catch (e) {
		console.log("[Observations] Stats error:", (e as Error).message);
		return { total: 0, byType: {}, available: false };
	}
}
