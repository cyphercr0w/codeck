/**
 * teammate-watcher — Detects tmux teammate panes for sessions with Agent Teams enabled.
 *
 * When a session has CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1, Claude Code creates
 * a tmux session internally. This watcher polls tmux for panes and broadcasts
 * teammate info to the frontend so it can show tabs.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { broadcast } from "../web/logger.js";

const execFileAsync = promisify(execFile);

interface TeammateInfo {
	paneId: string;
	paneIndex: string;
	command: string;
	title: string;
	width: number;
	height: number;
	active: boolean;
}

// sessionId → { tmuxSession, interval, knownPanes }
const watchers = new Map<
	string,
	{
		tmuxSession: string | null;
		interval: ReturnType<typeof setInterval>;
		knownPanes: Map<string, TeammateInfo>;
		pid: number;
	}
>();

// Guard to prevent overlapping async polls
const pollingGuard = new Set<string>();

const POLL_MS = 3000;

/**
 * Start watching for teammate panes for a teams-enabled session.
 * Call this after spawning a PTY with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1.
 */
export function startTeammateWatcher(sessionId: string, pid: number): void {
	if (watchers.has(sessionId)) return;

	const state = {
		tmuxSession: null as string | null,
		interval: null as unknown as ReturnType<typeof setInterval>,
		knownPanes: new Map<string, TeammateInfo>(),
		pid,
	};

	state.interval = setInterval(() => {
		if (pollingGuard.has(sessionId)) return;
		pollingGuard.add(sessionId);
		pollPanes(sessionId, state)
			.catch(() => {})
			.finally(() => pollingGuard.delete(sessionId));
	}, POLL_MS);

	watchers.set(sessionId, state);
	console.log(
		`[TeammateWatcher] Started for session ${sessionId.slice(0, 8)} (PID ${pid})`,
	);
}

/**
 * Stop watching for a session.
 */
export function stopTeammateWatcher(sessionId: string): void {
	const state = watchers.get(sessionId);
	if (!state) return;
	clearInterval(state.interval);
	pollingGuard.delete(sessionId);
	watchers.delete(sessionId);
}

/**
 * Get current teammates for a session.
 */
export function getTeammates(sessionId: string): TeammateInfo[] {
	const state = watchers.get(sessionId);
	if (!state) return [];
	return Array.from(state.knownPanes.values());
}

async function pollPanes(
	sessionId: string,
	state: {
		tmuxSession: string | null;
		knownPanes: Map<string, TeammateInfo>;
		pid: number;
	},
): Promise<void> {
	// Step 1: find the tmux session if not yet known
	if (!state.tmuxSession) {
		state.tmuxSession = await findTmuxSession(state.pid);
		if (!state.tmuxSession) return; // not created yet
		console.log(
			`[TeammateWatcher] Found tmux session: ${state.tmuxSession} for PID ${state.pid}`,
		);
	}

	// Step 2: list panes
	let output: string;
	try {
		const result = await execFileAsync(
			"tmux",
			[
				"list-panes",
				"-t",
				state.tmuxSession,
				"-F",
				"#{pane_id}||#{pane_index}||#{pane_current_command}||#{pane_title}||#{pane_width}||#{pane_height}||#{pane_active}",
			],
			{ encoding: "utf-8", timeout: 3000 },
		);
		output = result.stdout.trim();
	} catch {
		return; // session may have died
	}

	if (!output) return;

	const currentPanes = new Map<string, TeammateInfo>();
	for (const line of output.split("\n")) {
		const [paneId, paneIndex, command, title, w, h, active] = line.split("||");
		if (!paneId) continue;
		// Skip pane 0 (the leader)
		if (paneIndex === "0") continue;
		currentPanes.set(paneId, {
			paneId,
			paneIndex,
			command: command || "unknown",
			title: title || `Agent #${paneIndex}`,
			width: parseInt(w) || 80,
			height: parseInt(h) || 24,
			active: active === "1",
		});
	}

	// Detect new panes
	for (const [paneId, info] of currentPanes) {
		if (!state.knownPanes.has(paneId)) {
			state.knownPanes.set(paneId, info);
			broadcast({
				type: "teammate:detected",
				data: {
					sessionId,
					paneId: info.paneId,
					paneIndex: info.paneIndex,
					name: info.title,
					command: info.command,
				},
			});
			console.log(
				`[TeammateWatcher] New teammate: ${info.title} (pane ${info.paneIndex}) in session ${sessionId.slice(0, 8)}`,
			);
		}
	}

	// Detect removed panes
	for (const [paneId, info] of state.knownPanes) {
		if (!currentPanes.has(paneId)) {
			state.knownPanes.delete(paneId);
			broadcast({
				type: "teammate:shutdown",
				data: {
					sessionId,
					paneId: info.paneId,
					paneIndex: info.paneIndex,
					name: info.title,
				},
			});
		}
	}
}

/**
 * Find tmux session created by a PID (or its children).
 * Claude Code with Agent Teams enabled creates a tmux session internally.
 */
async function findTmuxSession(pid: number): Promise<string | null> {
	try {
		const { stdout: sessions } = await execFileAsync(
			"tmux",
			["list-sessions", "-F", "#{session_name}"],
			{ encoding: "utf-8", timeout: 2000 },
		);
		const sessionList = sessions.trim();

		if (!sessionList) return null;

		// Find session that contains our PID's children
		for (const session of sessionList.split("\n")) {
			try {
				const { stdout: panes } = await execFileAsync(
					"tmux",
					["list-panes", "-t", session, "-F", "#{pane_pid}"],
					{ encoding: "utf-8", timeout: 2000 },
				);

				for (const panePid of panes.trim().split("\n")) {
					// Check if this pane's PID is a child of our session PID
					if (await isChildOf(parseInt(panePid), pid)) {
						return session;
					}
				}
			} catch {
				continue;
			}
		}
	} catch {
		// tmux not running yet
	}
	return null;
}

/**
 * Check if childPid is a descendant of parentPid.
 */
async function isChildOf(
	childPid: number,
	parentPid: number,
): Promise<boolean> {
	if (isNaN(childPid) || isNaN(parentPid)) return false;
	let current = childPid;
	for (let depth = 0; depth < 10; depth++) {
		if (current === parentPid) return true;
		if (current <= 1) return false;
		try {
			const { stdout: ppidStr } = await execFileAsync(
				"ps",
				["-o", "ppid=", "-p", String(current)],
				{
					encoding: "utf-8",
					timeout: 1000,
				},
			);
			current = parseInt(ppidStr.trim());
			if (isNaN(current)) return false;
		} catch {
			return false;
		}
	}
	return false;
}
