import {
	readFileSync,
	existsSync,
	mkdirSync,
	unlinkSync,
	renameSync,
} from "fs";
import { resolve } from "path";

import { atomicWriteFileSync } from "../memory.js";
import {
	sessions,
	SESSIONS_STATE_PATH,
	type SavedSession,
	type SessionsState,
} from "./types.js";

// ── Debounced Save ──

let saveStateTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced session state save — coalesces rapid saves (e.g., during restore of
 * multiple sessions) into a single disk write after 500ms of inactivity.
 */
export function saveSessionState(
	reason: string,
	continuationPrompt?: string,
): void {
	if (saveStateTimer) clearTimeout(saveStateTimer);
	saveStateTimer = setTimeout(() => {
		saveStateTimer = null;
		saveSessionStateNow(reason, continuationPrompt);
	}, 500);
}

export function saveSessionStateNow(
	reason: string,
	continuationPrompt?: string,
): SessionsState {
	const saved: SavedSession[] = [];
	for (const [, session] of sessions) {
		saved.push({
			id: session.id,
			type: session.type,
			cwd: session.cwd,
			name: session.name,
			reason,
			conversationId:
				session.type === "agent" ? session.conversationId : undefined,
			continuationPrompt:
				session.type === "agent" ? continuationPrompt : undefined,
		});
	}
	const state: SessionsState = {
		version: 1,
		savedAt: Date.now(),
		sessions: saved,
	};

	// If there are no sessions to save, remove the file entirely instead of writing an empty
	// state. This prevents phantom restore cycles: an empty sessions.json would cause
	// hasSavedSessions()=true on next startup, leading to a restore with 0 sessions and a
	// stuck "Restoring sessions..." overlay.
	if (saved.length === 0) {
		try {
			unlinkSync(SESSIONS_STATE_PATH);
		} catch {
			/* already gone */
		}
		console.log(
			`[Console] Removed sessions state (reason: ${reason}): no sessions to persist`,
		);
		return state;
	}

	const dir = resolve(SESSIONS_STATE_PATH, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	atomicWriteFileSync(SESSIONS_STATE_PATH, JSON.stringify(state, null, 2));

	const detail = saved
		.map(
			(s) =>
				`${s.id.slice(0, 8)}(conv:${s.conversationId?.slice(0, 8) || "none"})`,
		)
		.join(", ");
	console.log(
		`[Console] Saved ${saved.length} sessions (reason: ${reason}): ${detail || "none"}`,
	);
	return state;
}

// ── Restore Control ──

// Session restore disabled — caused persistent black screen bugs after container restart.
// Users restore sessions manually via "recent conversations" or "new agent".
// The save mechanism is kept so sessions.json has data, but restore is never triggered.
export function hasSavedSessions(): boolean {
	return false; // Always false — restore disabled
}

export function isPendingRestore(): boolean {
	return false; // Always false — restore disabled
}

export function clearPendingRestore(): void {
	// no-op
}

// ── Read Saved Sessions ──

/**
 * Read saved sessions from disk WITHOUT creating PTY processes.
 * Returns the list for the frontend to show Resume/Discard prompt.
 * PTY creation happens only when the user explicitly calls restoreSessionsNow().
 */
export function readSavedSessions(): Array<{
	id: string;
	type: string;
	cwd: string;
	name: string;
	conversationId?: string;
}> {
	if (!existsSync(SESSIONS_STATE_PATH)) return [];

	let state: SessionsState;
	try {
		const raw = JSON.parse(readFileSync(SESSIONS_STATE_PATH, "utf8"));
		state = {
			version: raw.version || 1,
			savedAt: raw.savedAt || Date.now(),
			sessions: raw.sessions || [],
		};
	} catch (e) {
		console.log(
			"[Console] Failed to parse sessions.json:",
			(e as Error).message,
		);
		return [];
	}

	console.log(
		`[Console] Found ${state.sessions.length} saved sessions (deferred — waiting for user action)`,
	);

	const result = state.sessions.map((s) => ({
		id: s.id,
		type: s.type || "agent",
		cwd: s.cwd,
		name: s.name || s.cwd.split("/").pop() || "session",
		conversationId: s.conversationId,
	}));

	// Rename to .bak so it doesn't re-trigger on next restart
	try {
		renameSync(SESSIONS_STATE_PATH, SESSIONS_STATE_PATH + ".bak");
	} catch {
		try {
			unlinkSync(SESSIONS_STATE_PATH);
		} catch {
			/* ignore */
		}
	}

	return result;
}
