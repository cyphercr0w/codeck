/**
 * tmux-bridge — Launches Agent Teams and bridges tmux panes to console sessions.
 *
 * Flow:
 * 1. Creates a tmux session with Claude Code + Agent Teams enabled
 * 2. Injects the team creation prompt (from TeamTemplate)
 * 3. Polls for new tmux panes (teammates spawned by Agent Teams)
 * 4. For each pane, creates a TmuxPtyAdapter → registers as ConsoleSession
 * 5. Broadcasts WS events so the frontend can attach xterm.js tabs
 */

import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { TmuxPtyAdapter } from "./tmux-pty-adapter.js";
import { registerVirtualSession, destroySession } from "./console.js";
import { saveTeamExecution } from "./teams.js";
import { getOAuthEnv } from "./claude-env.js";
import { broadcast } from "../web/logger.js";
import type {
	TeamTemplate,
	TeamExecution,
	TeamAgentState,
	TeamAgentDefinition,
} from "../types/team.types.js";

// ── State ──

const activeExecutions = new Map<
	string,
	{
		execution: TeamExecution;
		watcherInterval: ReturnType<typeof setInterval> | null;
		knownPanes: Set<string>;
		adapters: Map<string, TmuxPtyAdapter>;
	}
>();

const WORKSPACE = process.env.WORKSPACE || "/workspace";
const PANE_POLL_MS = 2000;

// ── Public API ──

/**
 * Launch a team from a template.
 */
export function launchTeam(
	template: TeamTemplate,
	options: { cwd?: string; input?: string },
): TeamExecution {
	const executionId = randomUUID();
	const tmuxSession = `team-${executionId.slice(0, 8)}`;
	const cwd = options.cwd || WORKSPACE;

	// Build agent state records
	const agents: Record<string, TeamAgentState> = {};
	for (const [id, agent] of Object.entries(template.agents)) {
		agents[id] = {
			agentId: id,
			name: agent.name,
			role: agent.role,
			sessionId: null,
			tmuxPane: null,
			status: "pending",
			detectedAt: null,
		};
	}

	const execution: TeamExecution = {
		id: executionId,
		templateId: template.id,
		templateName: template.name,
		status: "launching",
		tmuxSession,
		agents,
		leaderSessionId: null,
		startedAt: new Date().toISOString(),
		completedAt: null,
		initialPrompt: options.input || "",
	};

	// Create tmux session in the project workspace (not /app build dir)
	try {
		execFileSync(
			"tmux",
			[
				"new-session",
				"-d",
				"-s",
				tmuxSession,
				"-x",
				"160",
				"-y",
				"40",
				"-c",
				cwd,
			],
			{ timeout: 5000 },
		);
	} catch (e) {
		execution.status = "failed";
		saveTeamExecution(execution);
		throw new Error(`Failed to create tmux session: ${(e as Error).message}`);
	}

	// Auth strategy:
	// 1. Inline env vars in the claude command (affects the leader shell)
	// 2. set-environment -t session (affects teammate panes spawned later)
	// 3. set-environment -g -u removes stale API keys globally
	//
	// getOAuthEnv() returns the current valid OAuth token from the credential store.
	const oauthEnv = getOAuthEnv();
	const oauthToken = oauthEnv.CLAUDE_CODE_OAUTH_TOKEN || "";

	// Remove stale API keys from tmux global env (runtime process inherits them)
	for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]) {
		try {
			execFileSync("tmux", ["set-environment", "-g", "-u", key], {
				timeout: 2000,
			});
		} catch {
			/* may not exist */
		}
	}

	// Set session-level env for teammate panes
	const sessionEnv: Record<string, string> = {
		CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
	};
	if (oauthToken) sessionEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
	for (const [k, v] of Object.entries(sessionEnv)) {
		try {
			execFileSync("tmux", ["set-environment", "-t", tmuxSession, k, v], {
				timeout: 2000,
			});
		} catch {
			/* non-fatal */
		}
	}
	// Also remove stale API keys at session level
	for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]) {
		try {
			execFileSync("tmux", ["set-environment", "-t", tmuxSession, "-u", key], {
				timeout: 2000,
			});
		} catch {
			/* may not exist */
		}
	}

	// Build command with inline env vars for the leader shell (set-environment
	// only affects NEW panes, not the shell that already started with new-session).
	const inlineEnv = [
		"unset ANTHROPIC_API_KEY CLAUDE_API_KEY;",
		"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1",
		oauthToken ? `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}` : "",
	]
		.filter(Boolean)
		.join(" ");
	const claudeCmd = `${inlineEnv} claude --teammate-mode tmux --permission-mode acceptEdits`;

	// Use -l for literal text, then send Enter separately
	execFileSync(
		"tmux",
		["send-keys", "-t", tmuxSession, "-l", "--", claudeCmd],
		{
			timeout: 3000,
		},
	);
	execFileSync("tmux", ["send-keys", "-t", tmuxSession, "Enter"], {
		timeout: 3000,
	});

	// Register leader pane as a virtual session
	const leaderSessionId = randomUUID();
	execution.leaderSessionId = leaderSessionId;

	// Wait for Claude to be ready (shows ❯ prompt), then register leader and send prompt
	waitForClaudeReady(tmuxSession, 90_000).then(async (ready: boolean) => {
		if (!ready || !activeExecutions.has(executionId)) {
			execution.status = "failed";
			saveTeamExecution(execution);
			return;
		}

		try {
			// Register leader pane
			const leaderAdapter = new TmuxPtyAdapter(`${tmuxSession}:0.0`, {
				cols: 160,
				rows: 40,
			});
			registerVirtualSession(
				leaderSessionId,
				leaderAdapter as Parameters<typeof registerVirtualSession>[1],
				{
					cwd,
					name: `${template.name} — Leader`,
				},
			);

			activeExecutions.get(executionId)?.adapters.set("leader", leaderAdapter);

			// Build and send the team creation prompt (literal to prevent injection).
			// Claude Code treats multi-line pastes as [Pasted text] needing Enter to submit.
			// Send the text, wait for Claude to show [Pasted text], then send Enter.
			const prompt = buildTeamPrompt(template, options.input);
			const paneTarget = `${tmuxSession}:0.0`;
			execFileSync(
				"tmux",
				["send-keys", "-t", paneTarget, "-l", "--", prompt],
				{ timeout: 5000 },
			);
			// Wait for Claude to register the paste (shows [Pasted text]), then Enter.
			// Retry Enter up to 3 times — sometimes the first one arrives too early.
			for (let attempt = 0; attempt < 3; attempt++) {
				await new Promise((r) => setTimeout(r, 1500));
				execFileSync("tmux", ["send-keys", "-t", paneTarget, "Enter"], {
					timeout: 2000,
				});
				// Check if Claude started processing (no more [Pasted text] on screen)
				await new Promise((r) => setTimeout(r, 2000));
				try {
					const screen = execFileSync(
						"tmux",
						["capture-pane", "-t", paneTarget, "-p"],
						{ encoding: "utf-8", timeout: 2000 },
					);
					if (!screen.includes("[Pasted text")) break;
				} catch {
					break;
				}
			}

			execution.status = "running";
			saveTeamExecution(execution);

			// Broadcast team launched event
			broadcast({
				type: "team:launched",
				data: {
					executionId,
					templateName: template.name,
					agents: Object.values(template.agents).map((a) => ({
						id: a.id,
						name: a.name,
						role: a.role,
					})),
					leaderSessionId,
				},
			});

			// Start pane watcher
			startPaneWatcher(executionId);
		} catch (e) {
			console.error(`[TmuxBridge] Startup failed:`, (e as Error).message);
			execution.status = "failed";
			saveTeamExecution(execution);
		}
	});

	// Store execution state
	activeExecutions.set(executionId, {
		execution,
		watcherInterval: null,
		knownPanes: new Set(["0"]), // leader pane (index from #{pane_index})
		adapters: new Map(),
	});

	saveTeamExecution(execution);
	return execution;
}

/**
 * Launch an ad-hoc team (no template required).
 */
export function launchAdHocTeam(
	agents: Record<string, TeamAgentDefinition>,
	options: { name?: string; cwd?: string; input?: string },
): TeamExecution {
	const template: TeamTemplate = {
		id: `adhoc-${randomUUID().slice(0, 8)}`,
		name: options.name || "Ad-hoc Team",
		description: "Agent-initiated team",
		version: "1.0.0",
		isTemplate: false,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		agents,
	};
	return launchTeam(template, options);
}

/**
 * Stop a running team execution.
 */
export function stopTeam(executionId: string): boolean {
	const state = activeExecutions.get(executionId);
	if (!state) return false;

	// Stop watcher
	if (state.watcherInterval) {
		clearInterval(state.watcherInterval);
	}

	// Destroy all adapter sessions
	for (const [, adapter] of state.adapters) {
		adapter.destroy();
	}

	// Destroy registered console sessions
	if (state.execution.leaderSessionId) {
		destroySession(state.execution.leaderSessionId);
	}
	for (const agent of Object.values(state.execution.agents)) {
		if (agent.sessionId) {
			destroySession(agent.sessionId);
		}
	}

	// Kill tmux session
	try {
		execFileSync("tmux", ["kill-session", "-t", state.execution.tmuxSession], {
			timeout: 5000,
		});
	} catch {
		// Session may already be dead
	}

	// Update execution
	state.execution.status = "cancelled";
	state.execution.completedAt = new Date().toISOString();
	saveTeamExecution(state.execution);

	// Broadcast
	broadcast({
		type: "team:stopped",
		data: {
			executionId,
			status: "cancelled",
		},
	});

	activeExecutions.delete(executionId);
	return true;
}

/**
 * Get active team executions.
 */
export function getActiveTeamExecutions(): TeamExecution[] {
	return Array.from(activeExecutions.values()).map((s) => s.execution);
}

// ── Internal ──

function startPaneWatcher(executionId: string): void {
	const state = activeExecutions.get(executionId);
	if (!state) return;

	const watcherStartTime = Date.now();
	const WATCHER_TIMEOUT_MS = 180_000; // 3min — large teams need time to spawn

	const interval = setInterval(() => {
		if (!activeExecutions.has(executionId)) {
			clearInterval(interval);
			return;
		}

		const panes = listTmuxPanes(state.execution.tmuxSession);
		for (const pane of panes) {
			if (state.knownPanes.has(pane.index)) continue;
			state.knownPanes.add(pane.index);

			// New pane detected — bridge it
			bridgeNewPane(executionId, pane);
		}

		// Detect completion:
		// 1. tmux session died entirely
		// 2. No teammate panes running Claude anymore (they exited to bash or closed)
		// 3. No Claude processes for 60s — team failed to spawn or already finished
		const tmuxDead =
			panes.length === 0 && !isTmuxSessionAlive(state.execution.tmuxSession);
		const claudePanes = panes.filter((p) => p.command === "claude");
		const teammatesDone = claudePanes.length <= 1 && state.knownPanes.size > 1; // only leader (or none) still running claude
		const noClaudeRunning = claudePanes.length === 0;
		const timedOut = Date.now() - watcherStartTime > WATCHER_TIMEOUT_MS;

		if (tmuxDead || teammatesDone || (noClaudeRunning && timedOut)) {
			clearInterval(interval);
			const finalStatus =
				tmuxDead || (noClaudeRunning && timedOut) ? "failed" : "completed";
			state.execution.status = finalStatus;
			state.execution.completedAt = new Date().toISOString();
			saveTeamExecution(state.execution);

			if (noClaudeRunning && timedOut) {
				console.warn(
					`[TmuxBridge] Watcher timeout: no Claude processes for ${WATCHER_TIMEOUT_MS / 1000}s in ${state.execution.tmuxSession}`,
				);
			}

			// Kill the tmux session (leader is idle, work is done)
			try {
				execFileSync(
					"tmux",
					["kill-session", "-t", state.execution.tmuxSession],
					{ timeout: 5000 },
				);
			} catch {
				/* already dead */
			}

			broadcast({
				type: "team:stopped",
				data: { executionId, status: finalStatus },
			});
			activeExecutions.delete(executionId);
		}
	}, PANE_POLL_MS);

	state.watcherInterval = interval;
}

function bridgeNewPane(executionId: string, pane: TmuxPaneInfo): void {
	const state = activeExecutions.get(executionId);
	if (!state) return;

	const sessionId = randomUUID();
	const paneTarget = `${state.execution.tmuxSession}:0.${pane.index}`;

	// Try to identify which agent this pane belongs to
	const agentName = inferAgentName(pane, state.execution);

	// Create adapter
	const adapter = new TmuxPtyAdapter(paneTarget, {
		cols: pane.width,
		rows: pane.height,
	});

	// Register as console session
	registerVirtualSession(
		sessionId,
		adapter as Parameters<typeof registerVirtualSession>[1],
		{
			cwd: WORKSPACE,
			name: agentName,
		},
	);

	state.adapters.set(pane.index, adapter);

	// Update execution agents
	const matchingAgent = findMatchingAgent(pane, state.execution);
	if (matchingAgent) {
		matchingAgent.sessionId = sessionId;
		matchingAgent.tmuxPane = paneTarget;
		matchingAgent.status = "detected";
		matchingAgent.detectedAt = new Date().toISOString();
	}
	saveTeamExecution(state.execution);

	// Broadcast detection
	broadcast({
		type: "team:agent:detected",
		data: {
			executionId,
			agentId: matchingAgent?.agentId || pane.index,
			name: agentName,
			role: matchingAgent?.role || "Agent",
			sessionId,
			tmuxPane: paneTarget,
		},
	});

	console.log(
		`[TmuxBridge] Bridged pane ${paneTarget} → session ${sessionId.slice(0, 8)} (${agentName})`,
	);
}

/** Strip control/escape characters that could manipulate the terminal via send-keys. */
function sanitizeForTerminal(text: string): string {
	// Remove all C0/C1 control chars except \n and \t (safe for readability)
	// eslint-disable-next-line no-control-regex
	return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g, "");
}

function buildTeamPrompt(template: TeamTemplate, userInput?: string): string {
	const s = sanitizeForTerminal;
	const teamName = s(template.name).toLowerCase().replace(/\s+/g, "-");
	const agents = Object.values(template.agents);

	const agentDescs = agents
		.map(
			(a) =>
				`- name: "${s(a.id)}", role: "${s(a.role)}", prompt: "${s(a.systemPrompt)}"${a.allowedTools.length > 0 ? `, tools: [${a.allowedTools.map((t) => `"${String(t)}"`).join(", ")}]` : ""}`,
		)
		.join("\n");

	const taskBlock = userInput
		? [
				"",
				`After the team is created, use SendMessage to tell the first teammate (${agents[0]?.id || "agent"}) to start working on this task:`,
				s(userInput),
				"",
				"Do NOT wait for a response before sending the message. Send it immediately after team creation.",
			]
		: [];

	const parts = [
		`Use the TeamCreate tool RIGHT NOW to create a team called "${teamName}" with these ${agents.length} teammates:`,
		agentDescs,
		...taskBlock,
		"",
		"IMPORTANT: Use the TeamCreate tool, not HTTP APIs or any other method.",
	];

	return parts.filter(Boolean).join("\n");
}

// ── tmux helpers ──

interface TmuxPaneInfo {
	index: string;
	width: number;
	height: number;
	command: string;
	pid: string;
}

function isTmuxSessionAlive(sessionName: string): boolean {
	try {
		execFileSync("tmux", ["has-session", "-t", sessionName], { timeout: 2000 });
		return true;
	} catch {
		return false;
	}
}

function listTmuxPanes(sessionName: string): TmuxPaneInfo[] {
	try {
		const output = execFileSync(
			"tmux",
			[
				"list-panes",
				"-t",
				sessionName,
				"-F",
				"#{pane_index}||#{pane_width}||#{pane_height}||#{pane_current_command}||#{pane_pid}",
			],
			{ encoding: "utf-8", timeout: 3000 },
		).trim();

		return output.split("\n").map((line) => {
			const [index, width, height, command, pid] = line.split("||");
			return {
				index,
				width: parseInt(width) || 120,
				height: parseInt(height) || 30,
				command: command || "unknown",
				pid: pid || "0",
			};
		});
	} catch {
		return [];
	}
}

function inferAgentName(pane: TmuxPaneInfo, execution: TeamExecution): string {
	// Try to match by order (pane 1 = first agent, pane 2 = second, etc.)
	const agentEntries = Object.values(execution.agents);
	const paneIdx = parseInt(pane.index);
	if (paneIdx > 0 && paneIdx <= agentEntries.length) {
		return agentEntries[paneIdx - 1].name;
	}
	return `Agent #${pane.index}`;
}

function findMatchingAgent(
	pane: TmuxPaneInfo,
	execution: TeamExecution,
): TeamAgentState | null {
	const agentEntries = Object.values(execution.agents);
	const paneIdx = parseInt(pane.index);
	if (paneIdx > 0 && paneIdx <= agentEntries.length) {
		return agentEntries[paneIdx - 1];
	}
	return null;
}

/**
 * Poll tmux pane content until Claude shows its prompt (❯).
 * Handles interactive prompts (API key confirmation, login) by sending Enter.
 */
function waitForClaudeReady(
	tmuxSession: string,
	timeoutMs: number,
): Promise<boolean> {
	const pane = `${tmuxSession}:0.0`;
	const startTime = Date.now();
	const POLL_MS = 2000;

	return new Promise((resolve) => {
		const check = () => {
			if (Date.now() - startTime > timeoutMs) {
				console.error(
					`[TmuxBridge] Timed out waiting for Claude to start in ${tmuxSession}`,
				);
				resolve(false);
				return;
			}

			try {
				const screen = execFileSync(
					"tmux",
					["capture-pane", "-t", pane, "-p"],
					{
						encoding: "utf-8",
						timeout: 2000,
					},
				);

				// Claude is ready when it shows the input prompt
				if (screen.includes("❯")) {
					// API key confirmation: select "Yes" (option 1) then confirm
					if (screen.includes("Do you want to use this API key")) {
						// Press Up arrow to select "Yes", then Enter
						execFileSync("tmux", ["send-keys", "-t", pane, "Up"], {
							timeout: 1000,
						});
						execFileSync("tmux", ["send-keys", "-t", pane, "Enter"], {
							timeout: 1000,
						});
						setTimeout(check, POLL_MS);
						return;
					}
					// Generic confirmation prompt
					if (screen.includes("Enter to confirm")) {
						execFileSync("tmux", ["send-keys", "-t", pane, "Enter"], {
							timeout: 1000,
						});
						setTimeout(check, POLL_MS);
						return;
					}
					// "Not logged in" is cosmetic — Claude works fine with API key.
					// Only fail if there's no ❯ prompt at all (handled by timeout).
					// Ready!
					resolve(true);
					return;
				}

				// Not ready yet — check for interactive prompts that need Enter
				if (
					screen.includes("Enter to confirm") ||
					screen.includes("Do you want to use")
				) {
					execFileSync("tmux", ["send-keys", "-t", pane, "Enter"], {
						timeout: 1000,
					});
				}
			} catch {
				// tmux call failed — session may not exist yet
			}

			setTimeout(check, POLL_MS);
		};

		setTimeout(check, 5000); // Initial delay before first check
	});
}
