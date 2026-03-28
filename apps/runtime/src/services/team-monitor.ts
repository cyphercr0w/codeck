/**
 * Team Monitor — captures output from Claude Code native teammate tmux panes
 * and broadcasts it via WebSocket so the frontend can show real-time feedback.
 *
 * Detection: looks for tmux sockets matching `claude-swarm-*` in /tmp/tmux-0/.
 * Polling: every 1.5s, captures each pane via `tmux capture-pane` and diffs
 * against the previous state to emit only new lines.
 */

import { execFileSync } from "child_process";
import { readdirSync } from "fs";
import { broadcast } from "../web/logger.js";

const TMUX_SOCK_DIR = "/tmp/tmux-0";
const POLL_INTERVAL = 1500; // ms
const DETECT_INTERVAL = 5000; // ms — how often to scan for new swarm sessions

interface PaneState {
	lines: string[];
	agentName: string;
}

let activeSocket: string | null = null;
let paneStates = new Map<number, PaneState>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let detectTimer: ReturnType<typeof setInterval> | null = null;

/** Find the claude-swarm tmux socket name, if any. */
function findSwarmSocket(): string | null {
	try {
		const entries = readdirSync(TMUX_SOCK_DIR);
		const swarm = entries.find((e) => e.startsWith("claude-swarm-"));
		return swarm || null;
	} catch {
		return null;
	}
}

/** List panes in the swarm session with their indices and titles. */
function listPanes(
	socket: string,
): Array<{ index: number; title: string; pid: number }> {
	try {
		const raw = execFileSync(
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
			.map((line) => {
				const [idx, title, pid] = line.split("\t");
				return {
					index: parseInt(idx, 10),
					title: title || `pane-${idx}`,
					pid: parseInt(pid, 10),
				};
			});
	} catch {
		return [];
	}
}

/** Capture the visible content of a pane. */
function capturePane(socket: string, paneIndex: number): string[] {
	try {
		const raw = execFileSync(
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
function pollPanes(): void {
	if (!activeSocket) return;

	const panes = listPanes(activeSocket);
	if (panes.length === 0) {
		// Session might have ended
		stopPolling();
		return;
	}

	for (const pane of panes) {
		const current = capturePane(activeSocket, pane.index);
		const prev = paneStates.get(pane.index);
		const prevLines = prev?.lines || [];
		const agentName = prev?.agentName || parseAgentName(pane.title, pane.index);

		const newLines = diffLines(current, prevLines);

		// Update state
		paneStates.set(pane.index, { lines: current, agentName });

		// Broadcast new lines if any
		if (newLines.length > 0) {
			// Filter out noise: empty lines, prompt lines, system reminders
			const meaningful = newLines.filter((l) => {
				const trimmed = l.trim();
				if (!trimmed) return false;
				if (trimmed.startsWith("<system-reminder>")) return false;
				if (trimmed === "❯" || trimmed === "❯") return false;
				if (trimmed.match(/^CTX \d+%$/)) return false;
				if (trimmed.match(/^───+/)) return false;
				return true;
			});

			if (meaningful.length > 0) {
				broadcast({
					type: "team:pane:output",
					paneIndex: pane.index,
					agentName,
					lines: meaningful,
				});
			}
		}
	}
}

function startPolling(socket: string): void {
	if (pollTimer) return;
	activeSocket = socket;
	paneStates.clear();
	console.log(`[TeamMonitor] Started monitoring tmux socket: ${socket}`);

	// Initial pane scan
	const panes = listPanes(socket);
	for (const pane of panes) {
		const agentName = parseAgentName(pane.title, pane.index);
		paneStates.set(pane.index, { lines: [], agentName });
		console.log(`[TeamMonitor] Pane ${pane.index}: ${agentName}`);
	}

	// Broadcast initial team detection
	broadcast({
		type: "team:detected",
		socket,
		panes: panes.map((p) => ({
			index: p.index,
			name: parseAgentName(p.title, p.index),
		})),
	});

	pollTimer = setInterval(pollPanes, POLL_INTERVAL);
}

function stopPolling(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	if (activeSocket) {
		console.log(`[TeamMonitor] Stopped monitoring (session ended)`);
		broadcast({ type: "team:ended" });
		activeSocket = null;
		paneStates.clear();
	}
}

/** Periodically check for new swarm sessions. */
function detectLoop(): void {
	const socket = findSwarmSocket();

	if (socket && !activeSocket) {
		// New swarm session found
		startPolling(socket);
	} else if (!socket && activeSocket) {
		// Swarm session ended
		stopPolling();
	} else if (socket && activeSocket && socket !== activeSocket) {
		// Different swarm session — switch
		stopPolling();
		startPolling(socket);
	}
}

/** Start the team monitor. Call once at server startup. */
export function startTeamMonitor(): void {
	console.log("[TeamMonitor] Initialized — watching for claude-swarm sessions");
	detectTimer = setInterval(detectLoop, DETECT_INTERVAL);
	// Run immediately
	detectLoop();
}

/** Stop the team monitor. Call on shutdown. */
export function stopTeamMonitor(): void {
	if (detectTimer) {
		clearInterval(detectTimer);
		detectTimer = null;
	}
	stopPolling();
}
