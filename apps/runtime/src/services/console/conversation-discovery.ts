import {
	readdir as readdirAsync,
	stat as statAsync,
} from "fs/promises";
import { resolve } from "path";

import { ACTIVE_AGENT } from "../agent.js";
import { broadcast } from "../../web/logger.js";
import { saveSessionState } from "./session-persistence.js";
import type { ConsoleSession } from "./types.js";
import { sessions } from "./types.js";
import { realpathSync } from "fs";

/**
 * Encode a project path the same way Claude Code does for ~/.claude/projects/.
 * Replaces /, \, :, and spaces with '-'.
 * Uses realpathSync to dereference symlinks — Claude CLI also resolves symlinks,
 * so a cwd like /home/codeck/workspace/codeck (→ /opt/codeck) must encode as -opt-codeck.
 */
export function encodeProjectPath(cwd: string): string {
	let absolute = resolve(cwd);
	try {
		absolute = realpathSync(absolute);
	} catch {
		/* path may not exist or resolve */
	}
	return absolute.replace(/[/\\: ]/g, "-");
}

/**
 * Check if a .jsonl file contains at least one real conversation message (async).
 * Reading large .jsonl conversation files synchronously was blocking for 100ms+ per file.
 */
export async function hasRealMessagesAsync(filePath: string): Promise<boolean> {
	// Stream the file line-by-line instead of reading the entire thing.
	// Conversation files can be 50-100MB; we only need to find the first
	// user/assistant line to confirm the conversation is real.
	try {
		const { createReadStream } = await import("fs");
		const { createInterface } = await import("readline");
		const rl = createInterface({
			input: createReadStream(filePath, "utf8"),
			crlfDelay: Infinity,
		});
		for await (const line of rl) {
			if (!line) continue;
			try {
				const d = JSON.parse(line);
				if (d.type === "user" || d.type === "assistant") {
					rl.close();
					return true;
				}
			} catch {
				/* skip malformed lines */
			}
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Detect the conversation ID for a Claude session by polling the project dir.
 * - Fresh sessions: wait for a NEW .jsonl file to appear.
 * - Resume/continue sessions: wait for an EXISTING .jsonl file's mtime to change
 *   (Claude writes to it when the conversation is resumed).
 * Runs async (fire-and-forget) — does not block session creation.
 */
/**
 * Detect the conversation ID using fully async I/O.
 * Previous implementation used readdirSync/statSync/readFileSync inside a 500ms setInterval,
 * which blocked the Node.js event loop for seconds when project directories had many .jsonl files.
 * This caused the runtime to stop processing WS messages (including console:input) → input freeze.
 */
export function detectConversationId(
	session: ConsoleSession,
	watchExisting = false,
): void {
	const encoded = encodeProjectPath(session.cwd);
	const projectDir = resolve(`${ACTIVE_AGENT.projectsDir}/${encoded}`);

	// Validate the resolved path stays within projectsDir to prevent path injection
	if (!ACTIVE_AGENT.projectsDir) return;
	const resolvedBase = resolve(ACTIVE_AGENT.projectsDir);
	if (
		!projectDir.startsWith(resolvedBase + "/") &&
		projectDir !== resolvedBase
	) {
		console.warn(
			`[Console] Path injection blocked: ${projectDir} is outside ${resolvedBase}`,
		);
		return;
	}

	(async () => {
		// Snapshot existing .jsonl files (and their mtimes for resume detection)
		const existingFiles = new Set<string>();
		const existingMtimes = new Map<string, number>();
		try {
			const entries = await readdirAsync(projectDir).catch(
				() => [] as string[],
			);
			for (const f of entries) {
				if (!f.endsWith(".jsonl")) continue;
				existingFiles.add(f);
				if (watchExisting) {
					try {
						const s = await statAsync(`${projectDir}/${f}`);
						existingMtimes.set(f, s.mtimeMs);
					} catch {
						/* ignore */
					}
				}
			}
		} catch {
			/* ignore */
		}

		// Poll (500ms intervals, up to 15s) — fully async to avoid blocking event loop
		let attempts = 0;
		const maxAttempts = 30;
		let polling = false;
		const interval = setInterval(async () => {
			if (polling) return; // Skip if previous async iteration still running
			// Stop polling if session was destroyed
			if (!sessions.has(session.id)) {
				clearInterval(interval);
				return;
			}
			polling = true;
			attempts++;
			try {
				const files = await readdirAsync(projectDir).catch(
					() => [] as string[],
				);
				const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

				let found: string | undefined;
				if (watchExisting) {
					// Resume mode: look for a file whose mtime has changed (Claude wrote to it)
					for (const f of jsonlFiles) {
						try {
							const s = await statAsync(`${projectDir}/${f}`);
							if (s.mtimeMs > (existingMtimes.get(f) ?? 0)) {
								found = f;
								break;
							}
						} catch {
							/* ignore */
						}
					}
				} else {
					// Fresh session: look for a brand-new file
					found = jsonlFiles.find((f) => !existingFiles.has(f));
				}

				if (found) {
					// Validate the file has real conversation messages (not just metadata like file-history-snapshot)
					if (!(await hasRealMessagesAsync(`${projectDir}/${found}`))) {
						// Not a real conversation yet — keep polling
						return;
					}
					session.conversationId = found.replace(".jsonl", "");
					saveSessionState("conversation_detected");
					console.log(
						`[Console] Detected conversation: ${session.conversationId} (${watchExisting ? "resume" : "new"})`,
					);
					// Notify frontend so "OPEN" badge appears on recent conversations
					broadcast({
						type: "session:conversationId",
						sessionId: session.id,
						conversationId: session.conversationId,
					});
					clearInterval(interval);
				} else if (attempts >= maxAttempts) {
					console.warn(
						`[Console] Could not detect conversation ID for session ${session.id}`,
					);
					clearInterval(interval);
				}
			} catch {
				clearInterval(interval);
			} finally {
				polling = false;
			}
		}, 500);
	})();
}

/**
 * Find the most recent valid conversation ID for the given cwd (async).
 * Uses async I/O to avoid blocking the event loop — the previous sync version
 * used readdirSync + statSync + readFileSync on every .jsonl file, which blocked
 * for seconds when project directories had many conversation files.
 */
export async function findMostRecentConversationAsync(
	cwd: string,
): Promise<string | undefined> {
	const encoded = encodeProjectPath(cwd);
	const projectDir = `${ACTIVE_AGENT.projectsDir}/${encoded}`;
	try {
		const entries = await readdirAsync(projectDir).catch(() => [] as string[]);
		const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));

		const fileStats = await Promise.all(
			jsonlFiles.map(async (f) => {
				try {
					const s = await statAsync(`${projectDir}/${f}`);
					return { name: f, mtime: s.mtimeMs };
				} catch {
					return null;
				}
			}),
		);

		const sorted = fileStats
			.filter((s): s is { name: string; mtime: number } => s !== null)
			.sort((a, b) => b.mtime - a.mtime);

		for (const { name } of sorted) {
			if (await hasRealMessagesAsync(`${projectDir}/${name}`)) {
				return name.replace(".jsonl", "");
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Check if a directory has previous Claude Code conversations that can be resumed.
 */
export async function hasResumableConversations(cwd: string): Promise<boolean> {
	const encoded = encodeProjectPath(cwd);
	const projectDir = `${ACTIVE_AGENT.projectsDir}/${encoded}`;
	try {
		const files = await readdirAsync(projectDir).catch(() => [] as string[]);
		return files.some((f) => f.endsWith(".jsonl"));
	} catch {
		return false;
	}
}
