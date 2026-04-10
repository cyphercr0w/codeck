/**
 * Memory Connectors Service
 *
 * Manages sync between different memory stores:
 * - markdown-directory: Scans .codeck/memory/**\/*.md and ensures indexed
 * - daily-log: Watches daily/ dir for new entries
 * - observation-index: Keeps observation SQLite in sync with FTS5
 *
 * Inspired by ECC2 memory connectors concept.
 */

import { existsSync, watch } from "fs";
import { join } from "path";
import { PATHS } from "./memory.js";
import { indexAll, isIndexerAvailable } from "./memory-indexer.js";

export interface ConnectorConfig {
	name: string;
	type: "markdown-directory" | "daily-log" | "observation-index";
	source: string; // source path or identifier
	target: string; // target path or identifier
	enabled: boolean;
	lastSync?: number; // epoch ms
}

export interface SyncResult {
	connector: string;
	filesScanned: number;
	filesIndexed: number;
	errors: string[];
	durationMs: number;
}

// ── Internal state ──

const connectors: Map<string, ConnectorConfig> = new Map();
let dailyLogWatcher: ReturnType<typeof watch> | null = null;
let dailyLogDebounce: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

// ── Built-in connector definitions ──

const BUILTIN_CONNECTORS: ConnectorConfig[] = [
	{
		name: "markdown-directory",
		type: "markdown-directory",
		source: PATHS.MEMORY_DIR,
		target: join(PATHS.INDEX_DIR, "memory.sqlite"),
		enabled: true,
	},
	{
		name: "daily-log",
		type: "daily-log",
		source: PATHS.DAILY_DIR,
		target: join(PATHS.INDEX_DIR, "memory.sqlite"),
		enabled: true,
	},
	{
		name: "observation-index",
		type: "observation-index",
		source: join(PATHS.INDEX_DIR, "memory.sqlite"),
		target: join(PATHS.INDEX_DIR, "memory.sqlite"),
		enabled: true,
	},
];

// ── Sync implementations ──

async function syncMarkdownDirectory(
	config: ConnectorConfig,
): Promise<SyncResult> {
	const start = Date.now();
	const errors: string[] = [];

	if (!isIndexerAvailable()) {
		return {
			connector: config.name,
			filesScanned: 0,
			filesIndexed: 0,
			errors: ["Indexer not available"],
			durationMs: Date.now() - start,
		};
	}

	const result = indexAll();
	if (!result.success && result.reason) {
		errors.push(result.reason);
	}

	// Update lastSync timestamp
	const updated = { ...config, lastSync: Date.now() };
	connectors.set(config.name, updated);

	return {
		connector: config.name,
		filesScanned: 0, // indexAll doesn't report exact count
		filesIndexed: result.success ? 1 : 0, // indicates indexAll ran successfully
		errors,
		durationMs: Date.now() - start,
	};
}

async function syncDailyLog(config: ConnectorConfig): Promise<SyncResult> {
	const start = Date.now();
	const errors: string[] = [];

	if (!isIndexerAvailable()) {
		return {
			connector: config.name,
			filesScanned: 0,
			filesIndexed: 0,
			errors: ["Indexer not available"],
			durationMs: Date.now() - start,
		};
	}

	// Re-index just daily files by running indexAll (it skips unchanged hashes)
	const result = indexAll();
	if (!result.success && result.reason) {
		errors.push(result.reason);
	}

	// Update lastSync timestamp
	const updated = { ...config, lastSync: Date.now() };
	connectors.set(config.name, updated);

	return {
		connector: config.name,
		filesScanned: 1,
		filesIndexed: result.success ? 1 : 0,
		errors,
		durationMs: Date.now() - start,
	};
}

async function syncObservationIndex(
	config: ConnectorConfig,
): Promise<SyncResult> {
	const start = Date.now();
	const errors: string[] = [];

	if (!isIndexerAvailable()) {
		return {
			connector: config.name,
			filesScanned: 0,
			filesIndexed: 0,
			errors: ["Indexer not available — observation FTS5 validation skipped"],
			durationMs: Date.now() - start,
		};
	}

	// Placeholder: validate that the SQLite database is accessible.
	// When the observations table is added (task #3), this will verify
	// that FTS5 triggers for the observations table exist.
	try {
		const BetterSqlite3 = (await import("better-sqlite3")).default;
		const db = new BetterSqlite3(config.source, { readonly: true });

		// Check if observations table exists (will be created by task #3)
		const tableExists = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='observations'",
			)
			.get();

		if (tableExists) {
			// Verify FTS5 triggers for observations exist
			const triggers = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'observations_%'",
				)
				.all() as { name: string }[];

			const triggerNames = triggers.map((t) => t.name);
			const requiredTriggers = [
				"observations_ai",
				"observations_ad",
				"observations_au",
			];
			for (const required of requiredTriggers) {
				if (!triggerNames.includes(required)) {
					errors.push(`Missing FTS5 trigger: ${required}`);
				}
			}
		}
		// If observations table doesn't exist yet, that's fine — it's pending task #3

		db.close();
	} catch (e) {
		errors.push(`Observation index validation failed: ${(e as Error).message}`);
	}

	// Update lastSync timestamp
	const updated = { ...config, lastSync: Date.now() };
	connectors.set(config.name, updated);

	return {
		connector: config.name,
		filesScanned: 0,
		filesIndexed: 0,
		errors,
		durationMs: Date.now() - start,
	};
}

// ── Daily log watcher ──

function startDailyLogWatcher(): void {
	if (dailyLogWatcher) return;
	if (!existsSync(PATHS.DAILY_DIR)) return;

	try {
		dailyLogWatcher = watch(
			PATHS.DAILY_DIR,
			{ recursive: false },
			(_event, filename) => {
				if (!filename || !filename.endsWith(".md")) return;

				// Debounce: trigger re-index after 2s of quiet
				if (dailyLogDebounce) clearTimeout(dailyLogDebounce);
				dailyLogDebounce = setTimeout(() => {
					const config = connectors.get("daily-log");
					if (config && config.enabled && isIndexerAvailable()) {
						indexAll();
						const updated = { ...config, lastSync: Date.now() };
						connectors.set("daily-log", updated);
						console.log(
							"[Connectors] daily-log: triggered re-index from watcher",
						);
					}
				}, 2000);
			},
		);
		console.log("[Connectors] daily-log watcher started");
	} catch (e) {
		console.log(
			"[Connectors] Could not start daily-log watcher:",
			(e as Error).message,
		);
	}
}

// ── Public API ──

export function initializeConnectors(): void {
	if (initialized) return;

	// Register all built-in connectors
	for (const config of BUILTIN_CONNECTORS) {
		connectors.set(config.name, { ...config });
	}

	// Start file watcher for daily-log connector
	startDailyLogWatcher();

	initialized = true;
	console.log(`[Connectors] Initialized ${connectors.size} connectors`);
}

export async function syncAll(): Promise<SyncResult[]> {
	const results: SyncResult[] = [];

	for (const config of connectors.values()) {
		if (!config.enabled) continue;
		try {
			const result = await syncConnector(config.name);
			results.push(result);
		} catch (e) {
			results.push({
				connector: config.name,
				filesScanned: 0,
				filesIndexed: 0,
				errors: [(e as Error).message],
				durationMs: 0,
			});
		}
	}

	return results;
}

export async function syncConnector(name: string): Promise<SyncResult> {
	const config = connectors.get(name);
	if (!config) {
		return {
			connector: name,
			filesScanned: 0,
			filesIndexed: 0,
			errors: [`Connector not found: ${name}`],
			durationMs: 0,
		};
	}

	if (!config.enabled) {
		return {
			connector: name,
			filesScanned: 0,
			filesIndexed: 0,
			errors: ["Connector is disabled"],
			durationMs: 0,
		};
	}

	switch (config.type) {
		case "markdown-directory":
			return syncMarkdownDirectory(config);
		case "daily-log":
			return syncDailyLog(config);
		case "observation-index":
			return syncObservationIndex(config);
		default:
			return {
				connector: name,
				filesScanned: 0,
				filesIndexed: 0,
				errors: [`Unknown connector type: ${(config as ConnectorConfig).type}`],
				durationMs: 0,
			};
	}
}

export function getConnectorStatus(): ConnectorConfig[] {
	return Array.from(connectors.values()).map((c) => ({ ...c }));
}

export function shutdownConnectors(): void {
	if (dailyLogWatcher) {
		dailyLogWatcher.close();
		dailyLogWatcher = null;
	}
	if (dailyLogDebounce) {
		clearTimeout(dailyLogDebounce);
		dailyLogDebounce = null;
	}
	connectors.clear();
	initialized = false;
	console.log("[Connectors] Shut down");
}
