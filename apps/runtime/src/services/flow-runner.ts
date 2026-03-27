/**
 * Agent Flows — Execution orchestrator
 *
 * Runs a FlowExecution through a FlowDefinition's agent graph.
 * Each agent spawns a `claude` CLI process in --print mode,
 * collects output, resolves transitions, and advances to the
 * next agent until reaching END or hitting the loop limit.
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { appendFile } from "fs/promises";
import { join } from "path";

import { broadcast } from "../web/logger.js";
import { saveExecution } from "./flows.js";
import {
	getValidAgentBinary,
	getOAuthEnv,
	buildCleanEnv,
	ensureOnboardingComplete,
} from "./claude-env.js";
import { syncToClaudeSettings } from "./permissions.js";
import { syncCredentialsAfterCLI } from "./auth-anthropic.js";
import { decryptValue } from "./auth-anthropic/encryption.js";

import type {
	FlowDefinition,
	FlowExecution,
	AgentDefinition,
	AgentResult,
	AgentStatus,
} from "../types/flow.types.js";

// ── Constants ──

const WORKSPACE = process.env.WORKSPACE || "/workspace";
const EXECUTIONS_DIR = join(WORKSPACE, ".codeck", "flows", "executions");

// ── Running process registry ──

const runningProcesses = new Map<string, ChildProcess>();
const cancelledExecutions = new Set<string>();

// ── Main orchestrator ──

/**
 * Execute a flow: walk the agent graph from entryAgentId to END.
 *
 * Mutates `execution` in place and persists via saveExecution() at each step.
 * Broadcasts WebSocket events for real-time UI updates.
 */
export async function runFlow(
	execution: FlowExecution,
	flow: FlowDefinition,
	cwd?: string,
): Promise<void> {
	execution.status = "running";
	execution.currentAgentId = flow.entryAgentId;
	saveExecution(execution);
	broadcast({ type: "flow:execution:update", data: execution });

	let currentAgentId: string | null = flow.entryAgentId;
	let prevOutput: string = execution.initialInput;
	const agentVisitCounts = new Map<string, number>();

	while (currentAgentId && currentAgentId !== "END") {
		// Cancelled externally via cancelExecution()?
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
			console.error(`[FlowRunner] Agent not found in flow: ${currentAgentId}`);
			return;
		}

		// Anti-loop: track visits per agent.
		// Increment loopCount when the entry agent is revisited (complete cycle),
		// but also guard against non-entry agent cycles via per-agent visit limits.
		const visits = (agentVisitCounts.get(currentAgentId) || 0) + 1;
		agentVisitCounts.set(currentAgentId, visits);
		if (visits > 1 && currentAgentId === flow.entryAgentId) {
			execution.loopCount++;
		}

		const maxAgentVisits = agent.maxVisits ?? 10;
		if (visits > maxAgentVisits) {
			execution.status = "failed";
			execution.completedAt = new Date().toISOString();
			saveExecution(execution);
			broadcast({ type: "flow:execution:update", data: execution });
			console.error(
				`[FlowRunner] Execution ${execution.id}: agent ${currentAgentId} exceeded max visits (${maxAgentVisits})`,
			);
			return;
		}

		if (execution.loopCount >= execution.maxLoops) {
			execution.status = "failed";
			execution.completedAt = new Date().toISOString();
			saveExecution(execution);
			broadcast({ type: "flow:execution:update", data: execution });
			console.error(
				`[FlowRunner] Execution ${execution.id} hit max loops (${execution.maxLoops})`,
			);
			return;
		}

		// Update current agent
		execution.currentAgentId = currentAgentId;
		saveExecution(execution);
		broadcast({ type: "flow:execution:update", data: execution });

		// Build prompt with variable substitution
		const prompt = buildPrompt(agent.systemPrompt, agent.inputTemplate, {
			prev_output: prevOutput,
			flow_context: execution.initialInput,
		});

		// Run the agent
		let result: AgentResult;
		try {
			result = await runAgent(agent, prompt, execution.id, cwd);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			result = {
				agentId: agent.id,
				status: "failed",
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
				output: `Agent execution error: ${errorMsg}`,
			};
			console.error(`[FlowRunner] Agent ${agent.id} error: ${errorMsg}`);
		}

		// Store result — use composite key to preserve history on loop revisits
		const resultKey = visits > 1 ? `${agent.id}:${visits}` : agent.id;
		execution.agentResults[resultKey] = result;

		// Broadcast agent completion
		broadcast({
			type: "flow:agent:complete",
			data: { executionId: execution.id, agentId: agent.id, result },
		});

		saveExecution(execution);

		// If cancelled while agent was running, respect the cancellation
		if (cancelledExecutions.has(execution.id)) {
			cancelledExecutions.delete(execution.id);
			execution.status = "cancelled";
			execution.completedAt = new Date().toISOString();
			execution.currentAgentId = null;
			saveExecution(execution);
			broadcast({ type: "flow:execution:update", data: execution });
			return;
		}

		// If agent failed (and not cancelled), fail the execution
		if (result.status === "failed") {
			execution.status = "failed";
			execution.completedAt = new Date().toISOString();
			execution.currentAgentId = null;
			saveExecution(execution);
			broadcast({ type: "flow:execution:update", data: execution });
			return;
		}

		// Parse structured decision if agent uses structured output
		let decision: string | undefined;
		if (agent.outputParser === "structured" && agent.structuredOutputSchema) {
			decision = parseStructuredDecision(
				result.output,
				agent.structuredOutputSchema,
			);
			result.structuredDecision = decision;
			// Re-save with decision attached
			execution.agentResults[resultKey] = result;
			saveExecution(execution);
		}

		// Resolve next agent
		currentAgentId = resolveTransition(agent.transitions, decision);
		prevOutput = result.output;
	}

	// Flow completed successfully
	if (execution.status === "running") {
		execution.status = "completed";
	}
	execution.completedAt = new Date().toISOString();
	execution.currentAgentId = null;
	saveExecution(execution);
	broadcast({ type: "flow:execution:complete", data: execution });

	console.log(
		`[FlowRunner] Execution ${execution.id} completed: ${execution.status}`,
	);
}

// ── Agent execution ──

/**
 * Spawn a single `claude` CLI process in --print mode and collect output.
 */
function runAgent(
	agent: AgentDefinition,
	prompt: string,
	executionId: string,
	agentCwd?: string,
): Promise<AgentResult> {
	return new Promise((resolve, reject) => {
		const startedAt = new Date().toISOString();

		ensureOnboardingComplete();
		syncToClaudeSettings();

		const binary = getValidAgentBinary();
		const oauthEnv = getOAuthEnv();
		const cleanEnv = buildCleanEnv();

		// Load user env vars (API keys, tokens saved via Integrations UI)
		const flowUserEnv: Record<string, string> = {};
		const flowWsDir = join(WORKSPACE, ".codeck");
		const flowEncEnvPath = join(flowWsDir, ".env.encrypted");
		const flowDotenvPath = join(flowWsDir, ".env");

		if (existsSync(flowEncEnvPath)) {
			try {
				const store = JSON.parse(readFileSync(flowEncEnvPath, "utf-8"));
				for (const v of store.vars || []) {
					if (v.key && v.value) flowUserEnv[v.key] = decryptValue(v.value);
				}
			} catch {
				/* fall through to plaintext */
			}
		}
		if (Object.keys(flowUserEnv).length === 0 && existsSync(flowDotenvPath)) {
			try {
				const content = readFileSync(flowDotenvPath, "utf-8");
				for (const line of content.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith("#")) continue;
					const eqIdx = trimmed.indexOf("=");
					if (eqIdx > 0) {
						const key = trimmed.slice(0, eqIdx).trim();
						const val = trimmed
							.slice(eqIdx + 1)
							.trim()
							.replace(/^["']|["']$/g, "");
						if (key && val) flowUserEnv[key] = val;
					}
				}
			} catch {
				/* non-fatal */
			}
		}

		const finalEnv: Record<string, string> = {
			...cleanEnv,
			...flowUserEnv,
			...oauthEnv,
			TERM: "dumb",
			// Disable nonessential features inside flow agents to avoid hook blocking
			CLAUDE_CODE_DISABLE_NONESSENTIAL: "1",
		};

		// Build spawn arguments — use stream-json for real-time output
		// --verbose is required for stream-json to work with --print
		// --settings points to a clean config without hooks (hooks block flow agents)
		// acceptEdits auto-approves file edits (bypassPermissions blocked under root)
		const flowSettings = join(
			process.env.WORKSPACE || "/workspace",
			".codeck",
			"flow-agent-settings.json",
		);
		const spawnArgs: string[] = [
			"-p",
			prompt,
			"--output-format",
			"stream-json",
			"--verbose",
			"--no-session-persistence",
			"--permission-mode",
			"acceptEdits",
			"--settings",
			flowSettings,
		];

		// Pass allowed tools if configured — validate each name to prevent CLI injection
		const VALID_TOOL = /^[A-Za-z][A-Za-z0-9_]*$/;
		const safeTools = agent.allowedTools.filter((t: string) =>
			VALID_TOOL.test(t),
		);
		if (safeTools.length > 0) {
			spawnArgs.push("--allowedTools", safeTools.join(","));
		}

		// Pass max-turns if configured
		if (agent.maxTurns > 0) {
			spawnArgs.push("--max-turns", String(agent.maxTurns));
		}

		const cwd = agentCwd || WORKSPACE;

		console.log(
			`[FlowRunner] Spawning agent ${agent.id}: ${binary} ${spawnArgs.map((a) => (a.length > 80 ? a.slice(0, 77) + "..." : a)).join(" ")}`,
		);

		const child = spawn(binary, spawnArgs, {
			cwd,
			env: finalEnv,
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Close stdin immediately — stream-json needs stdin open briefly then closed
		// to avoid the "no stdin data" warning that blocks output
		child.stdin?.end();

		// Register running process for cancellation
		runningProcesses.set(executionId, child);

		// Prepare JSONL log directory
		const agentLogDir = join(EXECUTIONS_DIR, executionId, "agents");
		if (!existsSync(agentLogDir)) {
			mkdirSync(agentLogDir, { recursive: true, mode: 0o700 });
		}
		const jsonlPath = join(agentLogDir, `${agent.id}.jsonl`);

		let outputBuffer = "";
		let timedOut = false;
		let settled = false;
		let streamBuffer = ""; // Buffer for incomplete JSON lines from stream-json
		let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

		// Tool call tracking — emit tool names/summaries into the output stream
		// so the frontend can show what tools the agent is using in real time.
		let activeToolName = "";
		let activeToolInput = "";
		let insideToolUse = false;
		const toolCallLog: string[] = []; // Track all tool calls for fallback summary

		// Timeout handler — guard against zero/negative values
		const effectiveTimeout = Math.max(agent.timeoutMs, 5000);
		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			console.log(
				`[FlowRunner] Agent ${agent.id} timed out after ${effectiveTimeout}ms`,
			);
			child.kill("SIGTERM");
			sigkillTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already dead */
				}
			}, 15000);
		}, effectiveTimeout);

		/** Summarize a tool call input into a compact one-liner for the output stream. */
		const summarizeToolInput = (name: string, inputStr: string): string => {
			try {
				const input = JSON.parse(inputStr);
				switch (name) {
					case "Read":
						return input.file_path || "";
					case "Write":
						return input.file_path || "";
					case "Edit":
						return input.file_path || "";
					case "Bash":
						return (input.command || "").slice(0, 80);
					case "Glob":
						return input.pattern || "";
					case "Grep":
						return input.pattern || "";
					case "WebSearch":
						return input.query || "";
					case "WebFetch":
						return input.url || "";
					default:
						return Object.values(input).join(", ").slice(0, 60);
				}
			} catch {
				return "";
			}
		};

		/** Parse a single stream-json line and extract text content. */
		const parseStreamEvent = (raw: string): string => {
			if (!raw.trim()) return "";
			try {
				const event = JSON.parse(raw);
				if (event.type === "assistant" && event.message?.content) {
					let text = "";
					for (const block of event.message.content) {
						if (block.type === "text" && block.text) {
							text += block.text;
						}
					}
					return text;
				} else if (event.type === "content_block_delta" && event.delta?.text) {
					return event.delta.text;
				} else if (
					event.type === "content_block_delta" &&
					event.delta?.type === "input_json_delta" &&
					event.delta?.partial_json
				) {
					// Accumulate tool input JSON for summary on content_block_stop
					activeToolInput += event.delta.partial_json;
					return "";
				} else if (
					event.type === "content_block_start" &&
					event.content_block?.type === "tool_use"
				) {
					// Tool call started — record name, will emit summary on stop
					activeToolName = event.content_block.name || "unknown";
					activeToolInput = "";
					insideToolUse = true;
					return "";
				} else if (event.type === "content_block_stop" && insideToolUse) {
					// Tool call complete — emit a compact summary line
					const summary = summarizeToolInput(activeToolName, activeToolInput);
					const line = summary
						? `\n[${activeToolName}: ${summary}]\n`
						: `\n[${activeToolName}]\n`;
					toolCallLog.push(
						summary ? `${activeToolName}: ${summary}` : activeToolName,
					);
					activeToolName = "";
					activeToolInput = "";
					insideToolUse = false;
					return line;
				} else if (event.type === "result" && event.result) {
					// Result is the final aggregated output — skip to avoid
					// double-counting with content_block_delta events.
					// Only use it as a fallback if no deltas were received.
					if (!outputBuffer.trim()) {
						if (typeof event.result === "string") {
							return event.result;
						} else if (event.result.content) {
							let text = "";
							for (const block of event.result.content) {
								if (block.type === "text") text += block.text;
							}
							return text;
						}
					}
				}
			} catch {
				// Not valid JSON — treat as raw text
				return raw;
			}
			return "";
		};

		child.stdout?.on("data", (data: Buffer) => {
			const raw = data.toString();

			// Parse stream-json: each line is a JSON object
			streamBuffer += raw;
			const lines = streamBuffer.split("\n");
			streamBuffer = lines.pop() || ""; // Keep incomplete last line

			for (const line of lines) {
				const textChunk = parseStreamEvent(line);

				if (textChunk) {
					outputBuffer += textChunk;

					// Log to JSONL (async — don't block event loop)
					const logLine =
						JSON.stringify({
							timestamp: Date.now(),
							agentId: agent.id,
							type: "stdout",
							data: textChunk,
						}) + "\n";
					appendFile(jsonlPath, logLine).catch(() => {});

					// Broadcast live output to frontend
					broadcast({
						type: "flow:agent:output",
						data: { executionId, agentId: agent.id, chunk: textChunk },
					});
				}
			}
		});

		child.stderr?.on("data", (data: Buffer) => {
			const errChunk = data.toString();
			console.warn(`[FlowRunner] Agent ${agent.id} stderr: ${errChunk.trim()}`);

			// Also log stderr to JSONL (async)
			const logLine =
				JSON.stringify({
					timestamp: Date.now(),
					agentId: agent.id,
					type: "stderr",
					data: errChunk,
				}) + "\n";
			appendFile(jsonlPath, logLine).catch(() => {});
		});

		child.on("close", (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutHandle);
			if (sigkillTimer) clearTimeout(sigkillTimer);
			runningProcesses.delete(executionId);

			// Flush remaining streamBuffer — the last line may not end with \n
			if (streamBuffer.trim()) {
				const textChunk = parseStreamEvent(streamBuffer);
				if (textChunk) {
					outputBuffer += textChunk;
				}
				streamBuffer = "";
			}

			// Sync credentials — CLI may have refreshed the token
			syncCredentialsAfterCLI();

			const completedAt = new Date().toISOString();
			const succeeded = exitCode === 0 && !timedOut;

			const status: AgentStatus = succeeded ? "completed" : "failed";

			let finalOutput = outputBuffer.trim();

			// Guardrail: if agent produced no text output (only tool summaries
			// or completely empty), generate a fallback summary so the user
			// always sees something.
			const textOnly = finalOutput
				.replace(/\n?\[[\w]+:?[^\]]*\]\n?/g, "")
				.trim();
			if (!textOnly && toolCallLog.length > 0) {
				finalOutput = `Agent completed silently. Actions performed:\n${toolCallLog.map((t) => `  - ${t}`).join("\n")}`;
			} else if (!finalOutput) {
				finalOutput = `Agent completed with no output (exit code: ${exitCode}).`;
			}

			const result: AgentResult = {
				agentId: agent.id,
				status,
				startedAt,
				completedAt,
				output: finalOutput,
			};

			if (timedOut) {
				result.output += "\n\n[TIMED OUT]";
			}

			console.log(
				`[FlowRunner] Agent ${agent.id} finished: ${status} (exit: ${exitCode}, ${outputBuffer.length} bytes)`,
			);

			resolve(result);
		});

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutHandle);
			if (sigkillTimer) clearTimeout(sigkillTimer);
			runningProcesses.delete(executionId);

			reject(new Error(`Failed to spawn agent ${agent.id}: ${err.message}`));
		});
	});
}

// ── Prompt builder ──

/**
 * Replace template variables in the input template.
 * Supported variables: {{prev_output}}, {{flow_context}}
 */
function buildPrompt(
	systemPrompt: string,
	inputTemplate: string,
	variables: Record<string, string>,
): string {
	// Replace all variables in a single pass to prevent injection:
	// if prev_output contains "{{flow_context}}", it must NOT be expanded.
	let prompt = inputTemplate.replace(/\{\{(\w+)\}\}/g, (match, key) => {
		return key in variables ? variables[key] : match;
	});

	// Prepend system prompt as context
	if (systemPrompt) {
		prompt = `${systemPrompt}\n\n${prompt}`;
	}

	return prompt;
}

// ── Structured decision parser ──

/**
 * Extract a decision keyword from agent output.
 * Looks for "DECISION: WORD" pattern in the output text.
 * Falls back to checking if any of the enum values appear in the output.
 */
function parseStructuredDecision(
	output: string,
	schema: { decisionField: string; decisionsEnum: string[] },
): string | undefined {
	// Try explicit DECISION: WORD pattern
	const decisionPattern = /DECISION:\s*(\w+)/i;
	const match = output.match(decisionPattern);
	if (match) {
		const candidate = match[1].toUpperCase();
		if (schema.decisionsEnum.includes(candidate)) {
			return candidate;
		}
	}

	// Fallback: look for enum values as standalone words (word-boundary match)
	// in the last lines of output, since the decision is typically at the end.
	// Requires word boundaries to avoid matching substrings like "APPROVE" in
	// "I cannot APPROVE this because..."
	const lines = output.split("\n").reverse();
	for (const line of lines) {
		const upperLine = line.toUpperCase();
		for (const decision of schema.decisionsEnum) {
			const escaped = decision.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const wordPattern = new RegExp(`\\b${escaped}\\b`);
			if (wordPattern.test(upperLine)) {
				// Only match if the line is short (likely a standalone decision line)
				// or the decision appears as a standalone word/phrase, not mid-sentence
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

// ── Transition resolver ──

/**
 * Determine the next agent ID based on transitions and the structured decision.
 * Returns the next agentId or "END" to terminate the flow.
 */
function resolveTransition(
	transitions: AgentDefinition["transitions"],
	decision: string | undefined,
): string | null {
	// Check conditional transitions first (decision-based routing)
	if (decision && transitions.conditions) {
		for (const condition of transitions.conditions) {
			if (condition.when === decision) {
				return condition.goto === "END" ? null : condition.goto;
			}
		}
	}

	// Fall back to default transition
	if (transitions.default) {
		return transitions.default === "END" ? null : transitions.default;
	}

	// No transition defined — this is likely a misconfiguration.
	// Log a warning so flow authors can diagnose missing transitions.
	console.warn(
		`[FlowRunner] No transition found (decision=${decision ?? "none"}). ` +
			"Ending flow. Check that all transitions are configured correctly.",
	);
	return null;
}

// ── Cancellation ──

/**
 * Cancel a running flow execution by killing its active process.
 */
export function cancelExecution(executionId: string): void {
	cancelledExecutions.add(executionId);
	const child = runningProcesses.get(executionId);
	if (child) {
		console.log(`[FlowRunner] Cancelling execution ${executionId}`);
		child.kill("SIGTERM");
		setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already dead */
			}
		}, 5000);
		// Don't delete from runningProcesses here — let the close handler do it
		// to avoid a race window where a new process for the same execution could
		// have its entry lost.
	}
}
