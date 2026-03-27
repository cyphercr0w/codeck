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
	AgentResult,
} from "../../types/flow.types.js";

// ── Constants ──

const WORKSPACE = process.env.WORKSPACE || "/workspace";
const POLL_INTERVAL = 2000;
const DECISION_TIMEOUT = 300_000; // 5 min default

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

function parseStructuredDecision(
	output: string,
	schema: { decisionField: string; decisionsEnum: string[] },
): string | undefined {
	const decisionPattern = /DECISION:\s*(\w+)/i;
	const match = output.match(decisionPattern);
	if (match) {
		const candidate = match[1].toUpperCase();
		if (schema.decisionsEnum.includes(candidate)) return candidate;
	}
	const lines = output.split("\n").reverse();
	for (const line of lines) {
		const upperLine = line.toUpperCase();
		for (const decision of schema.decisionsEnum) {
			const escaped = decision.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const wordPattern = new RegExp(`\\b${escaped}\\b`);
			if (wordPattern.test(upperLine)) {
				const trimmed = upperLine.trim();
				if (
					trimmed === decision ||
					trimmed.startsWith(`${decision}:`) ||
					trimmed.startsWith(`${decision} `) ||
					trimmed.endsWith(decision)
				) {
					return decision;
				}
			}
		}
	}
	return undefined;
}

function resolveTransition(
	transitions: AgentDefinition["transitions"],
	decision: string | undefined,
): string | null {
	if (decision && transitions.conditions) {
		for (const condition of transitions.conditions) {
			if (condition.when === decision) {
				return condition.goto === "END" ? null : condition.goto;
			}
		}
	}
	if (transitions.default) {
		return transitions.default === "END" ? null : transitions.default;
	}
	return null;
}

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
					BROKER_URL: "http://localhost/api/peers",
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

	// Auto-confirm the --dangerously-load-development-channels interactive prompt.
	// Claude shows a selection menu that requires Enter to proceed.
	// Send Enter at staggered intervals to handle variable startup time.
	for (const delayMs of [1500, 3000, 5000]) {
		setTimeout(() => {
			try {
				writeToSession(session.id, "\r");
			} catch {
				/* session may already be dead — non-fatal */
			}
		}, delayMs);
	}

	return session.id;
}

function destroyPeerSessions(executionId: string): void {
	for (const [key, sessionId] of peerSessions) {
		if (key.startsWith(`${executionId}:`)) {
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

/**
 * Wait for a decision message from a specific agent.
 * Uses a per-execution orchestrator peerId to avoid cross-execution interference (#1, #14).
 * Checks cancellation flag to abort early (#6).
 * Re-queues non-decision messages to avoid data loss (#5).
 */
function waitForDecision(
	orchPeerId: string,
	executionId: string,
	timeoutMs: number,
): Promise<string | null> {
	return new Promise((resolve) => {
		const start = Date.now();
		const effectiveTimeout = Math.max(timeoutMs, 30_000);

		const check = () => {
			// Abort if cancelled (#6)
			if (cancelledExecutions.has(executionId)) {
				resolve(null);
				return;
			}

			const messages = pollMessages(orchPeerId);
			for (const msg of messages) {
				if (msg.executionId === executionId && msg.type === "decision") {
					resolve(msg.payload);
					return;
				}
				// Re-queue non-decision messages to avoid data loss (#5)
				// (shouldn't happen in practice but defensive)
				if (msg.type !== "decision") {
					sendMessage(
						msg.from,
						orchPeerId,
						msg.type,
						msg.payload,
						msg.executionId,
					);
				}
			}

			if (Date.now() - start > effectiveTimeout) {
				resolve(null);
				return;
			}

			setTimeout(check, POLL_INTERVAL);
		};

		check();
	});
}

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

// ── Main orchestrator ──

export async function runPeerFlow(
	execution: FlowExecution,
	flow: FlowDefinition,
	cwd?: string,
): Promise<void> {
	execution.status = "running";
	execution.currentAgentId = flow.entryAgentId;
	saveExecution(execution);
	broadcast({ type: "flow:execution:update", data: execution });

	// Register orchestrator with a fixed per-execution peerId (#1, #14)
	// This ensures pollMessages(orchPeerId) finds the correct queue.
	const orchPeerId = `orch-${execution.id}`;
	registerPeer({
		fixedPeerId: orchPeerId,
		agentId: orchPeerId,
		executionId: execution.id,
		role: "orchestrator",
		summary: "Flow orchestrator",
		pid: process.pid,
		sessionId: "",
	});

	let currentAgentId: string | null = flow.entryAgentId;
	let prevOutput: string = execution.initialInput;
	const agentVisitCounts = new Map<string, number>();
	const workDir = cwd || WORKSPACE;

	try {
		while (currentAgentId && currentAgentId !== "END") {
			if (cancelledExecutions.has(execution.id)) {
				cancelledExecutions.delete(execution.id);
				execution.status = "cancelled";
				execution.completedAt = new Date().toISOString();
				execution.currentAgentId = null;
				saveExecution(execution);
				broadcast({ type: "flow:execution:complete", data: execution });
				return;
			}

			const agent = flow.agents[currentAgentId];
			if (!agent) {
				execution.status = "failed";
				execution.completedAt = new Date().toISOString();
				saveExecution(execution);
				broadcast({ type: "flow:execution:update", data: execution });
				console.error(`[PeerRunner] Agent not found: ${currentAgentId}`);
				return;
			}

			const visits = (agentVisitCounts.get(currentAgentId) || 0) + 1;
			agentVisitCounts.set(currentAgentId, visits);
			if (visits > 1 && currentAgentId === flow.entryAgentId) {
				execution.loopCount++;
			}

			const maxAgentVisits = agent.maxVisits ?? 10;
			if (
				visits > maxAgentVisits ||
				execution.loopCount >= execution.maxLoops
			) {
				execution.status = "failed";
				execution.completedAt = new Date().toISOString();
				saveExecution(execution);
				broadcast({ type: "flow:execution:update", data: execution });
				console.error(
					`[PeerRunner] Max visits/loops exceeded for ${currentAgentId}`,
				);
				return;
			}

			execution.currentAgentId = currentAgentId;
			saveExecution(execution);
			broadcast({ type: "flow:execution:update", data: execution });

			await createPeerSession(agent, execution.id, workDir);

			const peer = await waitForPeerRegistration(
				execution.id,
				agent.id,
				60_000,
			);
			if (!peer) {
				console.error(
					`[PeerRunner] Agent ${agent.id} failed to register within 30s`,
				);
				execution.status = "failed";
				execution.completedAt = new Date().toISOString();
				saveExecution(execution);
				broadcast({ type: "flow:execution:update", data: execution });
				return;
			}

			const prompt = buildPrompt(agent.systemPrompt, agent.inputTemplate, {
				prev_output: prevOutput,
				flow_context: execution.initialInput,
			});

			const peerInstructions = `\n\nIMPORTANT: When you finish your work, use the report_decision tool to report your decision.`;
			const fullPrompt = prompt + peerInstructions;

			// Deliver prompt via broker → peer-server polls → channel push into Claude session.
			// Channel messages trigger Claude to act (they are NOT passive context).
			// Ref: https://code.claude.com/docs/en/channels-reference
			sendMessage(orchPeerId, peer.peerId, "prompt", fullPrompt, execution.id);

			const agentStartedAt = new Date().toISOString(); // Correct startedAt (#8)

			console.log(
				`[PeerRunner] Sent prompt to ${agent.id} via PTY (peer ${peer.peerId}, visit ${visits})`,
			);

			const decisionPayload = await waitForDecision(
				orchPeerId,
				execution.id,
				agent.timeoutMs || DECISION_TIMEOUT,
			);

			const completedAt = new Date().toISOString();
			const result: AgentResult = {
				agentId: agent.id,
				status: decisionPayload ? "completed" : "failed",
				startedAt: agentStartedAt, // (#8 fixed)
				completedAt,
				output: decisionPayload || `Agent ${agent.id} timed out.`,
			};

			let decision: string | undefined;
			if (
				agent.outputParser === "structured" &&
				agent.structuredOutputSchema &&
				decisionPayload
			) {
				decision = parseStructuredDecision(
					decisionPayload,
					agent.structuredOutputSchema,
				);
				result.structuredDecision = decision;
			}

			const resultKey = visits > 1 ? `${agent.id}:${visits}` : agent.id;
			execution.agentResults[resultKey] = result;

			broadcast({
				type: "flow:agent:complete",
				data: { executionId: execution.id, agentId: agent.id, result },
			});
			saveExecution(execution);

			if (!decisionPayload) {
				execution.status = "failed";
				execution.completedAt = new Date().toISOString();
				execution.currentAgentId = null;
				saveExecution(execution);
				broadcast({ type: "flow:execution:update", data: execution });
				return;
			}

			currentAgentId = resolveTransition(agent.transitions, decision);
			prevOutput = decisionPayload;
		}

		if (execution.status === "running") {
			execution.status = "completed";
		}
		execution.completedAt = new Date().toISOString();
		execution.currentAgentId = null;
		saveExecution(execution);
		broadcast({ type: "flow:execution:complete", data: execution });

		console.log(
			`[PeerRunner] Execution ${execution.id} completed: ${execution.status}`,
		);
	} finally {
		// Always clean up sessions — even on unhandled exceptions (#7)
		destroyPeerSessions(execution.id);
	}
}

// ── Helper: wait for peer to register ──

function waitForPeerRegistration(
	executionId: string,
	agentId: string,
	timeoutMs: number,
): Promise<ReturnType<typeof findPeerByAgent>> {
	return new Promise((resolve) => {
		const start = Date.now();
		const check = () => {
			const peer = findPeerByAgent(executionId, agentId);
			if (peer) {
				resolve(peer);
				return;
			}
			if (Date.now() - start > timeoutMs) {
				resolve(undefined);
				return;
			}
			setTimeout(check, 500);
		};
		check();
	});
}
