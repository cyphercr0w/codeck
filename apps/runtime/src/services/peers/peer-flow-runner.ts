/**
 * Peer Flow Runner — orchestrates flows using real Claude Code PTY sessions.
 *
 * Instead of spawning ephemeral `claude -p` processes, this runner:
 * 1. Creates persistent PTY sessions for each agent (reused across loops)
 * 2. Routes messages between agents via the in-process broker
 * 3. Each session loads the codeck-peer MCP server for claude/channel messaging
 *
 * The orchestrator registers as a per-execution peer (`orch-{executionId}`)
 * to receive decision messages without cross-execution interference.
 */

import { join, resolve as resolvePath } from "path";
import { writeFile, mkdir, unlink, readdir } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { broadcast } from "../../web/logger.js";
import { saveExecution } from "../flows.js";
import {
	registerPeer,
	sendMessage,
	pollMessages,
	cleanupExecution,
	findPeerByAgent,
} from "./broker.js";
import {
	createConsoleSession,
	destroySession,
	writeToSession,
} from "../console.js";
import type {
	FlowDefinition,
	FlowExecution,
	AgentDefinition,
} from "../../types/flow.types.js";

// ── Constants ──

const WORKSPACE = process.env.WORKSPACE || "/workspace";
const BROKER_URL = process.env.BROKER_URL || "http://localhost/api/peers";

// Sanitize agent IDs to prevent path traversal (#4)
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
function sanitizeId(id: string): string {
	if (SAFE_ID.test(id)) return id;
	return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ── Shared helpers (from flow-runner.ts) ──

function buildPrompt(
	systemPrompt: string,
	inputTemplate: string,
	variables: Record<string, string>,
): string {
	let prompt = inputTemplate.replace(/\{\{(\w+)\}\}/g, (match, key) => {
		return key in variables ? variables[key] : match;
	});
	if (systemPrompt) {
		prompt = `${systemPrompt}\n\n${prompt}`;
	}
	return prompt;
}

// parseStructuredDecision and resolveTransition removed —
// parallel model uses watchdog instead of sequential transitions.

// ── MCP config generation ──

async function generateMcpConfig(
	agentId: string,
	executionId: string,
	sessionId: string,
): Promise<string> {
	const safeAgent = sanitizeId(agentId);

	// Resolve the peer-server.mjs path
	const distPath = join(
		WORKSPACE,
		"codeck",
		"apps",
		"runtime",
		"dist",
		"peers",
		"peer-server.mjs",
	);
	const appPath = "/app/apps/runtime/dist/peers/peer-server.mjs";
	const srcPath = join(
		WORKSPACE,
		"codeck",
		"apps",
		"runtime",
		"src",
		"peers",
		"peer-server.mjs",
	);
	const peerServerPath = existsSync(distPath)
		? distPath
		: existsSync(appPath)
			? appPath
			: srcPath;

	const config = {
		mcpServers: {
			"codeck-peer": {
				command: "node",
				args: [peerServerPath],
				env: {
					PEER_AGENT_ID: safeAgent,
					PEER_EXECUTION_ID: executionId,
					PEER_SESSION_ID: sessionId,
					BROKER_URL,
				},
			},
		},
	};

	const configDir = join(WORKSPACE, ".codeck", "peers");
	await mkdir(configDir, { recursive: true });
	const configPath = join(configDir, `mcp-${executionId}-${safeAgent}.json`);

	// Validate resolved path is within configDir (#4 path traversal)
	const resolved = resolvePath(configPath);
	if (!resolved.startsWith(resolvePath(configDir))) {
		throw new Error(`Invalid config path: ${configPath}`);
	}

	await writeFile(configPath, JSON.stringify(config, null, 2));
	return configPath;
}

// ── Session management ──

const peerSessions = new Map<string, string>(); // "executionId:agentId" -> sessionId
const autoConfirmTimers = new Map<string, ReturnType<typeof setTimeout>[]>(); // "executionId:agentId" -> timer ids

function sessionKey(executionId: string, agentId: string): string {
	return `${executionId}:${agentId}`;
}

async function createPeerSession(
	agent: AgentDefinition,
	executionId: string,
	cwd: string,
): Promise<string> {
	const key = sessionKey(executionId, agent.id);

	// Reuse existing session (loop revisit — agent keeps context)
	const existing = peerSessions.get(key);
	if (existing) return existing;

	const sessionId = randomUUID();
	const mcpConfigPath = await generateMcpConfig(
		agent.id,
		executionId,
		sessionId,
	);

	// Use flow-agent-settings.json for a clean config: no hooks, no extra MCP servers.
	// This makes peer sessions start in ~10s instead of ~30s.
	const flowSettings = join(WORKSPACE, ".codeck", "flow-agent-settings.json");

	const extraArgs: string[] = [
		"--mcp-config",
		mcpConfigPath,
		"--dangerously-load-development-channels",
		"server:codeck-peer",
		"--permission-mode",
		"acceptEdits",
		"--settings",
		flowSettings,
		"--strict-mcp-config",
	];

	const VALID_TOOL = /^[A-Za-z][A-Za-z0-9_]*$/;
	const safeTools = agent.allowedTools.filter((t) => VALID_TOOL.test(t));
	if (safeTools.length > 0) {
		const peerTools = [
			"mcp__codeck-peer__list_peers",
			"mcp__codeck-peer__send_message",
			"mcp__codeck-peer__set_summary",
			"mcp__codeck-peer__check_messages",
			"mcp__codeck-peer__report_decision",
		];
		extraArgs.push("--allowedTools", [...safeTools, ...peerTools].join(","));
	}

	const session = createConsoleSession({
		cwd,
		sessionType: "peer",
		extraArgs,
		extraEnv: {
			PEER_AGENT_ID: agent.id,
			PEER_EXECUTION_ID: executionId,
			PEER_SESSION_ID: sessionId,
		},
	});

	peerSessions.set(key, session.id);
	console.log(
		`[PeerRunner] Created session ${session.id} for agent ${agent.id}`,
	);

	// Notify frontend so it can attach a terminal to this peer agent
	broadcast({
		type: "flow:peer:session_created",
		data: {
			executionId,
			agentId: agent.id,
			agentName: agent.name,
			sessionId: session.id,
		},
	});

	// Auto-confirm the --dangerously-load-development-channels interactive prompt.
	// Claude shows a selection menu that requires Enter to proceed.
	// Send Enter at staggered intervals to handle variable startup time.
	// Timers are tracked so they can be cleared on early session teardown.
	const timers: ReturnType<typeof setTimeout>[] = [];
	for (const delayMs of [1500, 3000, 5000]) {
		timers.push(
			setTimeout(() => {
				try {
					writeToSession(session.id, "\r");
				} catch {
					/* session may already be dead — non-fatal */
				}
			}, delayMs),
		);
	}
	autoConfirmTimers.set(key, timers);

	return session.id;
}

function destroyPeerSessions(executionId: string): void {
	for (const [key, sessionId] of peerSessions) {
		if (key.startsWith(`${executionId}:`)) {
			// Clear any pending auto-confirm timers for this session
			const timers = autoConfirmTimers.get(key);
			if (timers) {
				for (const t of timers) clearTimeout(t);
				autoConfirmTimers.delete(key);
			}
			try {
				destroySession(sessionId);
			} catch {
				/* already dead */
			}
			peerSessions.delete(key);
		}
	}
	cleanupExecution(executionId);
	cancelledExecutions.delete(executionId); // Prevent Set leak (#14)

	// Clean up MCP config temp files (#13)
	const configDir = join(WORKSPACE, ".codeck", "peers");
	readdir(configDir)
		.then((files) => {
			for (const f of files) {
				if (f.startsWith(`mcp-${executionId}-`)) {
					unlink(join(configDir, f)).catch(() => {});
				}
			}
		})
		.catch(() => {});
}

// ── Orchestrator message handling ──

// waitForDecision removed — parallel model uses watchForCompletion watchdog instead.

// ── Cancellation ──

const cancelledExecutions = new Set<string>();

export function cancelPeerExecution(executionId: string): void {
	cancelledExecutions.add(executionId);
	for (const key of peerSessions.keys()) {
		if (key.startsWith(`${executionId}:`)) {
			const agentId = key.split(":")[1];
			const peer = findPeerByAgent(executionId, agentId);
			if (peer) {
				sendMessage(
					"orchestrator",
					peer.peerId,
					"system",
					"CANCELLED",
					executionId,
				);
			}
		}
	}
	destroyPeerSessions(executionId);
}

// ── Main orchestrator (parallel model) ──
//
// All agents spawn simultaneously. The entrypoint receives the user's prompt.
// Agents communicate freely via the broker — they coordinate themselves.
// The orchestrator is a watchdog: it waits for a terminal decision (APPROVE/DONE)
// or a global timeout, then tears down all sessions.

const WATCHDOG_POLL = 3000;
const GLOBAL_TIMEOUT = 600_000; // 10 min max flow runtime

export async function runPeerFlow(
	execution: FlowExecution,
	flow: FlowDefinition,
	cwd?: string,
): Promise<void> {
	execution.status = "running";
	execution.currentAgentId = flow.entryAgentId;
	saveExecution(execution);
	broadcast({ type: "flow:execution:update", data: execution });

	const orchPeerId = `orch-${execution.id}`;
	registerPeer({
		fixedPeerId: orchPeerId,
		agentId: orchPeerId,
		executionId: execution.id,
		role: "orchestrator",
		summary: "Flow orchestrator (watchdog)",
		pid: process.pid,
		sessionId: "",
	});

	const workDir = cwd || WORKSPACE;
	const agentIds = Object.keys(flow.agents);

	try {
		// ── Phase 1: Spawn ALL agents in parallel ──
		console.log(
			`[PeerRunner] Spawning ${agentIds.length} agents in parallel...`,
		);

		const spawnResults = await Promise.allSettled(
			agentIds.map(async (agentId) => {
				const agent = flow.agents[agentId];
				await createPeerSession(agent, execution.id, workDir);
				const peer = await waitForPeerRegistration(
					execution.id,
					agentId,
					60_000,
				);
				if (!peer) {
					throw new Error(`Agent ${agentId} failed to register within 60s`);
				}
				return { agentId, peer };
			}),
		);

		// Check if any agent failed to start
		const failedAgents = spawnResults.filter((r) => r.status === "rejected");
		if (failedAgents.length > 0) {
			const reasons = failedAgents
				.map((r) =>
					r.status === "rejected" ? (r.reason as Error).message : "",
				)
				.join("; ");
			console.error(`[PeerRunner] Agent spawn failures: ${reasons}`);
			execution.status = "failed";
			execution.completedAt = new Date().toISOString();
			execution.currentAgentId = null;
			saveExecution(execution);
			broadcast({ type: "flow:execution:complete", data: execution });
			return;
		}

		// Build peer lookup from successful spawns
		const peerMap = new Map<string, string>(); // agentId → peerId
		for (const r of spawnResults) {
			if (r.status === "fulfilled") {
				peerMap.set(r.value.agentId, r.value.peer.peerId);
			}
		}

		console.log(
			`[PeerRunner] All ${agentIds.length} agents registered. Sending entrypoint prompt.`,
		);

		// ── Phase 2: Send initial prompt to entrypoint ──
		const entryAgent = flow.agents[flow.entryAgentId];
		const prompt = buildPrompt(
			entryAgent.systemPrompt,
			entryAgent.inputTemplate,
			{
				prev_output: execution.initialInput,
				flow_context: execution.initialInput,
			},
		);

		const peerInstructions = [
			"\n\nIMPORTANT INSTRUCTIONS:",
			"- You are the ENTRYPOINT agent. The user's task is above.",
			"- Use list_peers to see other agents. Use send_message to delegate work.",
			"- Other agents will send you results via channel messages.",
			"- When the overall objective is complete, use report_decision with APPROVE.",
			"- If something fails irrecoverably, use report_decision with FAILED.",
		].join("\n");

		const entryPeerId = peerMap.get(flow.entryAgentId)!;
		sendMessage(
			orchPeerId,
			entryPeerId,
			"prompt",
			prompt + peerInstructions,
			execution.id,
		);

		// Send system context to non-entrypoint agents so they know their role
		for (const [agentId, peerId] of peerMap) {
			if (agentId === flow.entryAgentId) continue;
			const agent = flow.agents[agentId];
			const agentContext = [
				agent.systemPrompt,
				"\n\nYou are a specialist agent in a multi-agent flow.",
				"Wait for messages from other agents via channel notifications.",
				"When you receive work, do it and send results back using send_message.",
				"Use report_decision with DONE when you finish all assigned work.",
				`The overall task: ${execution.initialInput}`,
			].join("\n");
			sendMessage(orchPeerId, peerId, "prompt", agentContext, execution.id);
		}

		console.log(`[PeerRunner] All prompts delivered. Watchdog active.`);

		// ── Phase 3: Watchdog — wait for terminal decision ──
		const finalDecision = await watchForCompletion(
			orchPeerId,
			execution.id,
			flow,
			peerMap,
		);

		// ── Phase 4: Record results ──
		const completedAt = new Date().toISOString();

		if (finalDecision) {
			execution.status = "completed";
			execution.agentResults.final = {
				agentId: finalDecision.agentId,
				status: "completed",
				startedAt: execution.startedAt,
				completedAt,
				output: finalDecision.payload,
				structuredDecision: finalDecision.decision,
			};
		} else {
			execution.status = cancelledExecutions.has(execution.id)
				? "cancelled"
				: "failed";
		}

		execution.completedAt = completedAt;
		execution.currentAgentId = null;
		saveExecution(execution);
		broadcast({ type: "flow:execution:complete", data: execution });

		console.log(`[PeerRunner] Execution ${execution.id} ${execution.status}`);
	} finally {
		destroyPeerSessions(execution.id);
	}
}

// ── Watchdog: monitors for completion signal ──

interface FinalDecision {
	agentId: string;
	payload: string;
	decision: string;
}

function watchForCompletion(
	orchPeerId: string,
	executionId: string,
	_flow: FlowDefinition,
	peerMap: Map<string, string>,
): Promise<FinalDecision | null> {
	return new Promise((resolve) => {
		const start = Date.now();
		let settled = false;
		let timerId: ReturnType<typeof setTimeout> | null = null;

		// Reverse map: peerId → agentId
		const peerToAgent = new Map<string, string>();
		for (const [agentId, peerId] of peerMap) {
			peerToAgent.set(peerId, agentId);
		}

		const settle = (value: FinalDecision | null) => {
			if (settled) return;
			settled = true;
			if (timerId !== null) clearTimeout(timerId);
			resolve(value);
		};

		const check = () => {
			if (settled) return;

			if (cancelledExecutions.has(executionId)) {
				settle(null);
				return;
			}

			// Poll orchestrator queue for decision messages from any agent
			const messages = pollMessages(orchPeerId);
			for (const msg of messages) {
				if (msg.executionId !== executionId) continue;
				if (msg.type === "decision") {
					const agentId = peerToAgent.get(msg.from) || msg.from;
					const decisionMatch = msg.payload.match(/DECISION:\s*(\w+)/i);
					const decision = decisionMatch
						? decisionMatch[1].toUpperCase()
						: "DONE";

					// Terminal decisions: APPROVE, DONE, FAILED
					if (["APPROVE", "DONE", "FAILED"].includes(decision)) {
						console.log(`[PeerRunner] Agent ${agentId} reported ${decision}`);
						broadcast({
							type: "flow:agent:complete",
							data: {
								executionId,
								agentId,
								result: {
									agentId,
									status: decision === "FAILED" ? "failed" : "completed",
									output: msg.payload,
									structuredDecision: decision,
								},
							},
						});
						settle({ agentId, payload: msg.payload, decision });
						return;
					}

					// Non-terminal decisions (REQUEST_CHANGES, LOOP) — log but keep watching
					console.log(
						`[PeerRunner] Agent ${agentId} reported non-terminal: ${decision}`,
					);
					broadcast({
						type: "flow:agent:complete",
						data: {
							executionId,
							agentId,
							result: {
								agentId,
								status: "completed",
								output: msg.payload,
								structuredDecision: decision,
							},
						},
					});
				}
			}

			// Global timeout
			if (Date.now() - start > GLOBAL_TIMEOUT) {
				console.error(
					`[PeerRunner] Global timeout (${GLOBAL_TIMEOUT / 1000}s) reached`,
				);
				settle(null);
				return;
			}

			timerId = setTimeout(check, WATCHDOG_POLL);
		};

		check();
	});
}

// ── Helper: wait for peer to register ──

function waitForPeerRegistration(
	executionId: string,
	agentId: string,
	timeoutMs: number,
): Promise<ReturnType<typeof findPeerByAgent>> {
	return new Promise((resolve) => {
		const start = Date.now();
		let settled = false;
		let timerId: ReturnType<typeof setTimeout> | null = null;

		const settle = (value: ReturnType<typeof findPeerByAgent>) => {
			if (settled) return;
			settled = true;
			if (timerId !== null) clearTimeout(timerId);
			resolve(value);
		};

		const check = () => {
			if (settled) return;
			const peer = findPeerByAgent(executionId, agentId);
			if (peer) {
				settle(peer);
				return;
			}
			if (Date.now() - start > timeoutMs) {
				settle(undefined);
				return;
			}
			timerId = setTimeout(check, 500);
		};
		check();
	});
}
