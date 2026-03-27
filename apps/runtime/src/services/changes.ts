/**
 * File Changes Tracker
 *
 * Tracks file modifications per session without git dependency.
 * PreToolUse hooks snapshot file content before edits.
 * PostToolUse hooks compute diffs and broadcast to frontend.
 *
 * Stores snapshots in memory (Map keyed by sessionId:filePath).
 * Diffs are computed using a simple LCS-based line diff algorithm.
 */

import { readFileSync, existsSync, statSync } from "fs";
import { relative, resolve, sep } from "path";
import { broadcast } from "../web/logger.js";

// ── Types ──

export interface FileDiff {
	path: string; // relative to workspace
	status: "added" | "modified" | "deleted";
	additions: number;
	deletions: number;
	hunks: DiffHunk[];
	timestamp: number;
}

export interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: DiffLine[];
}

export interface DiffLine {
	type: "add" | "del" | "ctx"; // context = unchanged
	content: string;
	oldLineNo?: number;
	newLineNo?: number;
}

// ── State ──

// Pre-edit snapshots: "sessionId:absolutePath" → file content (or null if new file)
const snapshots = new Map<string, string | null>();

// Diff windows per session: each user prompt creates a new window.
// Only the current window accumulates diffs; older windows are kept for viewing.
interface DiffWindow {
	id: number;
	startedAt: number;
	diffs: FileDiff[];
}

// sessionId → array of windows (newest last). Max 5 windows kept.
const sessionWindows = new Map<string, DiffWindow[]>();
let windowCounter = 0;
const MAX_WINDOWS = 5;

const WORKSPACE = process.env.WORKSPACE || "/workspace";
const MAX_SNAPSHOTS = 50; // Max files tracked simultaneously per session
const MAX_DIFFS_PER_SESSION = 100; // Max accumulated diffs per session
const MAX_FILE_SIZE = 500_000; // Don't snapshot files larger than 500KB
const MAX_SESSIONS = 10; // Purge oldest sessions if we exceed this

// ── Snapshot (called by PreToolUse hook) ──

export function snapshotFile(sessionId: string, filePath: string): void {
	// Workspace boundary check — prevent reading outside workspace
	const resolved = resolve(filePath);
	if (!resolved.startsWith(WORKSPACE + sep) && resolved !== WORKSPACE) return;

	const key = `${sessionId}:${filePath}`;
	if (snapshots.has(key)) return; // Already snapshotted this file in this prompt cycle

	// Enforce snapshot limit per session — evict oldest if full
	const sessionKeys = [...snapshots.keys()].filter((k) =>
		k.startsWith(`${sessionId}:`),
	);
	if (sessionKeys.length >= MAX_SNAPSHOTS) {
		snapshots.delete(sessionKeys[0]); // Evict oldest
	}

	try {
		if (existsSync(filePath)) {
			const stat = statSync(filePath);
			if (stat.size > MAX_FILE_SIZE) return; // Skip large files
			snapshots.set(key, readFileSync(filePath, "utf-8"));
		} else {
			snapshots.set(key, null); // File doesn't exist yet — will be "added"
		}
	} catch {
		snapshots.set(key, null);
	}
}

// ── Diff computation (called by PostToolUse hook) ──

export function computeAndBroadcastDiff(
	sessionId: string,
	filePath: string,
): FileDiff | null {
	// Workspace boundary check
	const resolvedPath = resolve(filePath);
	if (!resolvedPath.startsWith(WORKSPACE + sep) && resolvedPath !== WORKSPACE)
		return null;

	const key = `${sessionId}:${filePath}`;

	// If snapshot was never taken (file too large or skipped), bail out
	if (!snapshots.has(key)) return null;

	const before = snapshots.get(key);

	let after: string | null;
	try {
		if (existsSync(filePath)) {
			const stat = statSync(filePath);
			if (stat.size > MAX_FILE_SIZE) return null; // After-state too large
			after = readFileSync(filePath, "utf-8");
		} else {
			after = null;
		}
	} catch {
		after = null;
	}

	// No change
	if (before === after) return null;
	// Both null (file never existed and still doesn't)
	if (before === null && after === null) return null;

	const relPath = relative(WORKSPACE, filePath);
	const beforeLines = before?.split("\n") ?? [];
	const afterLines = after?.split("\n") ?? [];

	let status: FileDiff["status"];
	if (before === null || before === undefined) {
		status = "added";
	} else if (after === null) {
		status = "deleted";
	} else {
		status = "modified";
	}

	const hunks = computeHunks(beforeLines, afterLines);
	let additions = 0;
	let deletions = 0;
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			if (line.type === "add") additions++;
			if (line.type === "del") deletions++;
		}
	}

	const diff: FileDiff = {
		path: relPath,
		status,
		additions,
		deletions,
		hunks,
		timestamp: Date.now(),
	};

	// Store in current diff window
	const window = getCurrentWindow(sessionId);
	const existingIdx = window.diffs.findIndex(
		(d: FileDiff) => d.path === relPath,
	);
	if (existingIdx >= 0) {
		window.diffs[existingIdx] = diff;
	} else {
		if (window.diffs.length >= MAX_DIFFS_PER_SESSION) {
			window.diffs.shift();
		}
		window.diffs.push(diff);
	}

	// Broadcast to frontend
	broadcast({
		type: "changes:file",
		sessionId,
		data: { ...diff, windowId: window.id },
	});

	return diff;
}

// ── Window management ──

function getCurrentWindow(sessionId: string): DiffWindow {
	let windows = sessionWindows.get(sessionId);
	if (!windows || windows.length === 0) {
		// Purge oldest sessions if too many
		if (sessionWindows.size >= MAX_SESSIONS) {
			const oldest = sessionWindows.keys().next().value;
			if (oldest) {
				sessionWindows.delete(oldest);
				for (const k of snapshots.keys()) {
					if (k.startsWith(`${oldest}:`)) snapshots.delete(k);
				}
			}
		}
		windows = [{ id: ++windowCounter, startedAt: Date.now(), diffs: [] }];
		sessionWindows.set(sessionId, windows);
	}
	return windows[windows.length - 1];
}

/** Rotate to a new diff window — called on each user prompt (UserPromptSubmit hook) */
export function rotateDiffWindow(sessionId: string): void {
	let windows = sessionWindows.get(sessionId);
	if (!windows) {
		windows = [];
		sessionWindows.set(sessionId, windows);
	}

	// Only rotate if the current window has diffs (don't create empty windows)
	const current = windows[windows.length - 1];
	if (current && current.diffs.length === 0) return;

	// Evict oldest windows beyond limit
	while (windows.length >= MAX_WINDOWS) {
		windows.shift();
	}

	windows.push({ id: ++windowCounter, startedAt: Date.now(), diffs: [] });

	// Clear snapshots — new window starts fresh
	for (const k of snapshots.keys()) {
		if (k.startsWith(`${sessionId}:`)) snapshots.delete(k);
	}

	// Broadcast window rotation to frontend
	broadcast({
		type: "changes:window",
		sessionId,
		data: { windowId: windowCounter, previousWindows: windows.length - 1 },
	});
}

// ── Query API ──

/** Get diffs from the current (latest) window */
export function getSessionDiffs(sessionId: string): FileDiff[] {
	const windows = sessionWindows.get(sessionId);
	if (!windows || windows.length === 0) return [];
	return windows[windows.length - 1].diffs;
}

/** Get all windows for a session (for history view) */
export function getSessionWindows(sessionId: string): DiffWindow[] {
	return sessionWindows.get(sessionId) ?? [];
}

export function clearSessionDiffs(sessionId: string): void {
	sessionWindows.delete(sessionId);
	for (const k of snapshots.keys()) {
		if (k.startsWith(`${sessionId}:`)) snapshots.delete(k);
	}
}

export function getSessionDiffSummary(sessionId: string): {
	files: number;
	additions: number;
	deletions: number;
	windowId: number;
} {
	const diffs = getSessionDiffs(sessionId);
	let additions = 0;
	let deletions = 0;
	for (const d of diffs) {
		additions += d.additions;
		deletions += d.deletions;
	}
	const windows = sessionWindows.get(sessionId);
	const windowId = windows?.[windows.length - 1]?.id ?? 0;
	return { files: diffs.length, additions, deletions, windowId };
}

// ── Line diff algorithm (Myers-like with context) ──

function computeHunks(oldLines: string[], newLines: string[]): DiffHunk[] {
	// Compute LCS-based edit script
	const ops = diffLines(oldLines, newLines);

	// Group into hunks with 3 lines of context
	const CONTEXT = 3;
	const hunks: DiffHunk[] = [];
	let currentHunk: DiffHunk | null = null;
	let lastChangeIdx = -999;

	for (let i = 0; i < ops.length; i++) {
		const op = ops[i];
		if (op.type === "ctx") {
			// Context line — only include if near a change
			if (
				i - lastChangeIdx <= CONTEXT ||
				(i < ops.length - 1 && isNearChange(ops, i, CONTEXT))
			) {
				if (!currentHunk) {
					currentHunk = startHunk(op);
				}
				currentHunk.lines.push(op);
			} else if (currentHunk) {
				// End current hunk
				finalizeHunk(currentHunk);
				hunks.push(currentHunk);
				currentHunk = null;
			}
		} else {
			// Change line
			lastChangeIdx = i;
			if (!currentHunk) {
				// Start new hunk — include preceding context
				const ctxStart = Math.max(0, i - CONTEXT);
				currentHunk = {
					oldStart: ops[ctxStart]?.oldLineNo ?? 1,
					oldLines: 0,
					newStart: ops[ctxStart]?.newLineNo ?? 1,
					newLines: 0,
					lines: [],
				};
				for (let j = ctxStart; j < i; j++) {
					if (ops[j].type === "ctx") currentHunk.lines.push(ops[j]);
				}
			}
			currentHunk.lines.push(op);
		}
	}

	if (currentHunk && currentHunk.lines.length > 0) {
		finalizeHunk(currentHunk);
		hunks.push(currentHunk);
	}

	return hunks;
}

function isNearChange(ops: DiffLine[], idx: number, range: number): boolean {
	for (let i = idx + 1; i <= Math.min(idx + range, ops.length - 1); i++) {
		if (ops[i].type !== "ctx") return true;
	}
	return false;
}

function startHunk(firstOp: DiffLine): DiffHunk {
	return {
		oldStart: firstOp.oldLineNo ?? 1,
		oldLines: 0,
		newStart: firstOp.newLineNo ?? 1,
		newLines: 0,
		lines: [],
	};
}

function finalizeHunk(hunk: DiffHunk): void {
	let oldCount = 0;
	let newCount = 0;
	for (const line of hunk.lines) {
		if (line.type === "del" || line.type === "ctx") oldCount++;
		if (line.type === "add" || line.type === "ctx") newCount++;
	}
	hunk.oldLines = oldCount;
	hunk.newLines = newCount;
}

/**
 * Simple O(NM) LCS-based diff — produces edit ops with line numbers.
 * Good enough for files under 10K lines. For huge files we'd want Myers.
 */
function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
	const m = oldLines.length;
	const n = newLines.length;

	// For very large files, fall back to a simpler approach
	if (m * n > 5_000_000) {
		return simpleDiff(oldLines, newLines);
	}

	// Build LCS table
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array(n + 1).fill(0),
	);
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (oldLines[i - 1] === newLines[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	// Backtrack to produce ops
	const ops: DiffLine[] = [];
	let i = m;
	let j = n;
	const stack: DiffLine[] = [];

	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			stack.push({
				type: "ctx",
				content: oldLines[i - 1],
				oldLineNo: i,
				newLineNo: j,
			});
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			stack.push({
				type: "add",
				content: newLines[j - 1],
				newLineNo: j,
			});
			j--;
		} else {
			stack.push({
				type: "del",
				content: oldLines[i - 1],
				oldLineNo: i,
			});
			i--;
		}
	}

	// Reverse (we built from bottom-up)
	while (stack.length > 0) {
		ops.push(stack.pop()!);
	}

	return ops;
}

/** Fallback for very large files — just show all old as deleted, all new as added */
function simpleDiff(oldLines: string[], newLines: string[]): DiffLine[] {
	const ops: DiffLine[] = [];
	for (let i = 0; i < oldLines.length; i++) {
		ops.push({ type: "del", content: oldLines[i], oldLineNo: i + 1 });
	}
	for (let i = 0; i < newLines.length; i++) {
		ops.push({ type: "add", content: newLines[i], newLineNo: i + 1 });
	}
	return ops;
}
