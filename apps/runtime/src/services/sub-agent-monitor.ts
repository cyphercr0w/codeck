/**
 * Sub-Agent Monitor — captures output from Claude Code native teammate tmux panes
 * and broadcasts it via WebSocket so the frontend can show real-time feedback.
 *
 * Detection: looks for tmux sockets matching `claude-swarm-*` in /tmp/tmux-0/.
 * Polling: every 1.5s, captures each pane via `tmux capture-pane` and diffs
 * against the previous state to emit only new lines.
 */

import { execFile } from "child_process";
import { readdir } from "fs/promises";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { broadcast } from "../web/logger.js";

const TMUX_SOCK_DIR = "/tmp/tmux-0";
const POLL_INTERVAL = 1500; // ms
const DETECT_INTERVAL = 2000; // ms — how often to scan for new swarm sessions

interface PaneState {
	lines: string[];
	agentName: string;
}

let activeSocket: string | null = null;
let paneStates = new Map<number, PaneState>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let detectTimer: ReturnType<typeof setInterval> | null = null;

/** Find the claude-swarm tmux socket name, if any. Verifies the socket is alive. */
async function findSwarmSocket(): Promise<string | null> {
	try {
		const entries = await readdir(TMUX_SOCK_DIR);
		for (const entry of entries) {
			if (!entry.startsWith("claude-swarm-")) continue;
			try {
				await execFileAsync("tmux", ["-L", entry, "list-sessions"], {
					timeout: 2000,
				});
				console.log(`[SubAgentMonitor] Socket found and alive: ${entry}`);
				return entry;
			} catch {
				// stale socket — skip
				continue;
			}
		}
	} catch {}
	return null;
}

/** List panes in the swarm session with their indices and titles. */
async function listPanes(
	socket: string,
): Promise<Array<{ index: number; title: string; pid: number }>> {
	try {
		const { stdout: raw } = await execFileAsync(
			"tmux",
			[
				"-L",
				socket,
				"list-panes",
				"-a",
				"-F",
				"#{pane_index}\t#{pane_title}\t#{pane_pid}",
			],
			{ encoding: "utf8", timeout: 3000 },
		);

		return raw
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line: string) => {
				const parts = line.split("\t");
				const idx = parseInt(parts[0] ?? "", 10);
				const pid = parseInt(parts[2] ?? "", 10);
				if (isNaN(idx) || isNaN(pid)) return null;
				return {
					index: idx,
					title: parts[1] || `pane-${idx}`,
					pid,
				};
			})
			.filter(
				(p): p is { index: number; title: string; pid: number } => p !== null,
			);
	} catch {
		return [];
	}
}

/** Capture the visible content of a pane. */
async function capturePane(
	socket: string,
	paneIndex: number,
): Promise<string[]> {
	try {
		const { stdout: raw } = await execFileAsync(
			"tmux",
			[
				"-L",
				socket,
				"capture-pane",
				"-t",
				`claude-swarm:0.${paneIndex}`,
				"-p",
				"-S",
				"-50", // last 50 lines
			],
			{ encoding: "utf8", timeout: 3000 },
		);

		return raw.split("\n");
	} catch {
		return [];
	}
}

/** Extract agent name from pane title. Title format: "_ Review modal fix implementation" */
function parseAgentName(title: string, paneIndex: number): string {
	// Title is typically "_ <description>" — use the pane index to match
	// with known teammate names from the team config
	const clean = title.replace(/^_\s*/, "").trim();
	return clean || `agent-${paneIndex}`;
}

/** Diff current pane content against previous state and return new lines. */
function diffLines(current: string[], previous: string[]): string[] {
	if (previous.length === 0) return current.filter((l) => l.trim());

	// Find where the new content diverges from the old
	// Strategy: find the last matching line from previous in current
	const prevFiltered = previous.filter((l) => l.trim());
	const currFiltered = current.filter((l) => l.trim());

	if (prevFiltered.length === 0) return currFiltered;

	// Find the last line of previous in current
	const lastPrev = prevFiltered[prevFiltered.length - 1];
	let matchIdx = -1;
	for (let i = currFiltered.length - 1; i >= 0; i--) {
		if (currFiltered[i] === lastPrev) {
			matchIdx = i;
			break;
		}
	}

	if (matchIdx === -1) {
		// Content changed completely — might be a screen clear. Send last few lines.
		return currFiltered.slice(-5);
	}

	// Return lines after the match
	return currFiltered.slice(matchIdx + 1);
}

/** Single poll cycle: capture all panes, diff, broadcast new lines. */
let polling = false;
async function pollPanes(): Promise<void> {
	if (!activeSocket || polling) return;
	polling = true;
	try {
		const panes = await listPanes(activeSocket);
		if (panes.length === 0) {
			stopPolling();
			return;
		}
		console.log(
			`[SubAgentMonitor] Panes listed: ${panes.map((p) => `${p.index}:${p.title}`).join(", ")}`,
		);

		// Prune stale pane entries
		const activePaneIndices = new Set(panes.map((p) => p.index));
		for (const idx of paneStates.keys()) {
			if (!activePaneIndices.has(idx)) paneStates.delete(idx);
		}

		for (const pane of panes) {
			const current = await capturePane(activeSocket!, pane.index);
			const prev = paneStates.get(pane.index);
			const prevLines = prev?.lines || [];
			const agentName =
				prev?.agentName || parseAgentName(pane.title, pane.index);

			const newLines = diffLines(current, prevLines);

			paneStates.set(pane.index, { lines: current, agentName });

			if (newLines.length > 0) {
				const meaningful = newLines.filter((l) => {
					const trimmed = l.trim();
					if (!trimmed) return false;
					if (trimmed.startsWith("<system-reminder>")) return false;
					if (trimmed === "❯") return false;
					if (/^CTX \d+%$/.test(trimmed)) return false;
					if (/^───+/.test(trimmed)) return false;
					return true;
				});

				if (meaningful.length > 0) {
					console.log(
						`[SubAgentMonitor] Pane ${pane.index} (${agentName}): ${meaningful.length} new line(s) captured`,
					);
					broadcast({
						type: "subagent:pane:output",
						paneIndex: pane.index,
						agentName,
						lines: meaningful,
					});
					console.log(
						`[SubAgentMonitor] Broadcast sent for pane ${pane.index}`,
					);
				}
			}
		}
	} finally {
		polling = false;
	}
}

async function startPolling(socket: string): Promise<void> {
	if (pollTimer) return;
	activeSocket = socket;
	paneStates.clear();
	console.log(`[SubAgentMonitor] Started monitoring tmux socket: ${socket}`);

	const panes = await listPanes(socket);
	for (const pane of panes) {
		const agentName = parseAgentName(pane.title, pane.index);
		paneStates.set(pane.index, { lines: [], agentName });
		console.log(`[SubAgentMonitor] Pane ${pane.index}: ${agentName}`);
	}

	broadcast({
		type: "subagent:detected",
		socket,
		panes: panes.map((p) => ({
			index: p.index,
			name: parseAgentName(p.title, p.index),
		})),
	});

	pollTimer = setInterval(() => {
		pollPanes().catch(() => {});
	}, POLL_INTERVAL);
}

function stopPolling(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	if (activeSocket) {
		console.log(`[SubAgentMonitor] Stopped monitoring (session ended)`);
		broadcast({ type: "subagent:ended" });
		activeSocket = null;
		paneStates.clear();
	}
}

/** Periodically check for new swarm sessions. */
async function detectLoop(): Promise<void> {
	const socket = await findSwarmSocket();

	if (socket && !activeSocket) {
		startPolling(socket).catch(() => {});
	} else if (!socket && activeSocket) {
		stopPolling();
	} else if (socket && activeSocket && socket !== activeSocket) {
		stopPolling();
		startPolling(socket).catch(() => {});
	}
}

/** Start the sub-agent monitor. Call once at server startup. */
export function startSubAgentMonitor(): void {
	console.log(
		"[SubAgentMonitor] Initialized — watching for claude-swarm sessions",
	);
	detectTimer = setInterval(detectLoop, DETECT_INTERVAL);
	// Run immediately
	detectLoop();
}

/** Stop the sub-agent monitor. Call on shutdown. */
export function stopSubAgentMonitor(): void {
	if (detectTimer) {
		clearInterval(detectTimer);
		detectTimer = null;
	}
	stopPolling();
}
