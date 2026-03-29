import type { IPty } from "node-pty";
import { resolve } from "path";

// ── Constants ──

export const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB max buffered output per session
export const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || "5", 10);

export const SESSIONS_STATE_PATH = resolve(
	process.env.WORKSPACE || "/workspace",
	".codeck/state/sessions.json",
);

// ── Interfaces ──

export interface ConsoleSession {
	id: string;
	type: "agent" | "shell";
	pty: IPty;
	cwd: string;
	name: string;
	createdAt: number;
	outputBuffer: string[];
	outputBufferSize: number;
	attached: boolean;
	conversationId?: string;
	dataDisposable?: { dispose: () => void };
}

export interface CreateSessionOptions {
	cwd?: string;
	resume?: boolean;
	useContinue?: boolean; // use --continue (resumes most recent conv for cwd, no picker)
	continuationPrompt?: string;
	conversationId?: string;
}

export interface SavedSession {
	id: string;
	type: "agent" | "shell";
	cwd: string;
	name: string;
	reason: string;
	conversationId?: string;
	continuationPrompt?: string;
}

export interface SessionsState {
	version: number;
	savedAt: number;
	sessions: SavedSession[];
}

// ── Shared Session Map ──

export const sessions = new Map<string, ConsoleSession>();

// Set to true during destroyAllSessions() to suppress per-session state saves
// that would overwrite the shutdown snapshot with an empty session list.
export let suppressStateSave = false;
export function setSuppressStateSave(value: boolean): void {
	suppressStateSave = value;
}

// Callbacks invoked when any session's PTY exits — allows external modules
// (routes, websocket) to clean up per-session state without circular imports.
export type SessionExitCallback = (sessionId: string, exitCode: number) => void;
export const globalSessionExitCallbacks: SessionExitCallback[] = [];
