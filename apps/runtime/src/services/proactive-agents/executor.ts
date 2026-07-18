import os from "os";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, appendFile, readFileSync, writeFileSync, rmSync } from "fs";
import { writeFile as writeFileAsync, chmod as chmodAsync } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { stripVTControlCharacters } from "util";
import {
	getValidAgentBinary,
	getOAuthEnv,
	ensureOnboardingComplete,
	buildCleanEnv,
} from "../claude-env.js";
import { syncToClaudeSettings } from "../permissions.js";
import { sanitizeSecrets } from "../session-writer.js";
import { syncCredentialsAfterCLI } from "../auth-anthropic.js";
import { decryptValue } from "../auth-anthropic/encryption.js";
import type { AgentRuntime, ExecutionResult, BroadcastFn } from "./types.js";

// ── Constants ──

const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50MB per-execution log size limit

// ── Helpers ──

/**
 * Extract clean text from a stream-json JSONL line.
 * Returns extracted text or empty string if no text content.
 */
function extractTextFromStreamJson(line: string): string {
	try {
		const obj = JSON.parse(line);
		// assistant message with content blocks (full message)
		if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
			const text = obj.message.content
				.filter((b: any) => b.type === "text" && b.text)
				.map((b: any) => b.text)
				.join("");
			return text ? text + "\n" : "";
		}
		// content_block_delta with text delta (streaming chunks)
		if (obj.type === "content_block_delta" && obj.delta?.text) {
			return obj.delta.text;
		}
		// result message (final summary)
		if (obj.type === "result" && typeof obj.result === "string") {
			return "\n" + obj.result + "\n";
		}
		return "";
	} catch {
		return "";
	}
}

// ── Execution engine ──

export interface ExecutorDeps {
	agents: Map<string, AgentRuntime>;
	cwdLocks: Map<string, string>;
	broadcastFn: () => BroadcastFn;
	resolveAgentCwd: (cwd: string) => string;
	executionsDir: (id: string) => string;
	harnessDir: (id: string) => string;
	loopStateDir: (id: string) => string;
	inboxDir: (id: string) => string;
	saveState: (id: string, state: AgentRuntime["state"]) => void;
	stopCron: (runtime: AgentRuntime) => void;
	toSummary: (runtime: AgentRuntime) => object;
	pruneExecutions: (execDir: string) => void;
	processCwdQueue: (cwd: string) => void;
}

// ── Scheduled-loop (full-harness) run bootstrap ──

function permissionProfileClause(profile: string): string {
	switch (profile) {
		case "readonly":
			return "READONLY: do NOT modify files, commit, push, or run mutating commands. Investigate and write findings/recommendations to the inbox only.";
		case "full":
			return "FULL: you may take write actions the plan requires, including push/PR. Still ESCALATE anything ambiguous or destructive to the inbox.";
		case "safe-write":
		default:
			return "SAFE-WRITE: you may edit files and commit LOCALLY. NEVER push, deploy, publish, open external PRs, upgrade dependencies with meaningful risk, or run irreversible commands — ESCALATE those to the inbox instead of doing them.";
	}
}

interface LoopRun {
	prompt: string;
	extraEnv: Record<string, string>;
	taskDir: string;
}

/**
 * Bootstrap an isolated autonomous-harness control-plane for one loop tick and
 * build the loop-runner prompt. The plan is pre-approved (planApproved:true) — a
 * scheduled loop reads its fixed, vetted spec (plan.md) each tick rather than
 * re-planning — so the PO governs REVIEW/AUDIT/DONE, not the PLAN gate.
 * State lives under the per-agent dir and is wired to the hooks via
 * CODECK_HARNESS_DIR / CODECK_STATE_DIR so it never collides with an interactive
 * harness task in the web terminal.
 */
function buildLoopRun(
	runtime: AgentRuntime,
	executionId: string,
	startedAt: number,
	deps: ExecutorDeps,
): LoopRun {
	const id = runtime.config.id;
	const loop = runtime.config.loop!;
	const hDir = deps.harnessDir(id);
	const sDir = deps.loopStateDir(id);
	const inbox = deps.inboxDir(id);
	const taskId = `loop-${executionId.slice(0, 8)}`;

	// Fresh control-plane per tick — drop any prior tick's task + stale markers.
	try { rmSync(hDir, { recursive: true, force: true }); } catch { /* ignore */ }
	const taskDir = join(hDir, taskId);
	mkdirSync(taskDir, { recursive: true, mode: 0o700 });
	mkdirSync(sDir, { recursive: true, mode: 0o700 });
	mkdirSync(inbox, { recursive: true, mode: 0o700 });
	for (const m of ["review-marker.json", "audit-marker.json", "edit-tracker.json", "tool-signatures.json", "reprompts.json"]) {
		try { rmSync(join(sDir, m), { force: true }); } catch { /* ignore */ }
	}

	const planMd = [
		`# Scheduled Loop — vetted plan (do NOT re-plan)`,
		``,
		`This is the durable specification for a ${loop.mode} loop. Reread it each tick.`,
		``,
		`## Goal (observable stop condition)`,
		loop.goal,
		``,
		`## Machine gate (must pass to accept the work)`,
		"```",
		loop.verifyCmd,
		"```",
		``,
		`## Procedure`,
		`1. Triage: discover the actionable work toward the goal. Prefer the smallest verifiable units.`,
		`2. Implement one unit at a time; after each, run the machine gate above — it MUST return pass.`,
		`3. Review (code-reviewer) → audit (grader) → product-owner DONE verdict. Criteria go done ONLY with evidence.`,
		`4. Record work to memory; ESCALATE anything you cannot safely resolve to the inbox.`,
		``,
		`## Permission profile: ${loop.permissionProfile}`,
		permissionProfileClause(loop.permissionProfile),
	].join("\n");

	writeFileSync(join(hDir, "current.json"), JSON.stringify({ active: true, taskId }));
	writeFileSync(join(taskDir, "plan.md"), planMd);
	writeFileSync(
		join(taskDir, "progress.json"),
		JSON.stringify(
			{
				criteria: [
					{ id: "triage", desc: `Discover and resolve actionable work toward: ${loop.goal}`, status: "todo", evidence: "" },
					{ id: "verify", desc: `Machine gate passes: ${loop.verifyCmd}`, status: "todo", evidence: "" },
				],
				iterations: [],
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(taskDir, "budget.json"),
		JSON.stringify({ iterCap: loop.iterCap, costCapUsd: loop.costCapUsd, iterations: 0, spentUsd: 0 }),
	);
	writeFileSync(
		join(taskDir, "overseer.json"),
		JSON.stringify({
			mode: "autonomous",
			phase: "implement",
			planApproved: true,
			done: false,
			escalated: false,
			directive: "",
			verdict: "APPROVE_PLAN",
			updatedAt: startedAt,
		}),
	);

	const prompt = [
		`You are an UNATTENDED scheduled loop running inside a Codeck sandbox. No human is watching — NEVER ask a question. If something needs human judgment or an irreversible action, ESCALATE (write an inbox file) instead of acting or waiting.`,
		``,
		`TASK: ${runtime.config.objective}`,
		`GOAL (observable stop condition): ${loop.goal}`,
		`MACHINE GATE (must pass to accept the work): ${loop.verifyCmd}`,
		``,
		`You are resuming autonomous-harness task "${taskId}". Its control-plane lives in an ISOLATED directory — use THESE exact paths for ALL harness/state/marker reads and writes (NOT the default /workspace/.codeck/harness):`,
		`  harness dir: ${hDir}`,
		`  state dir:   ${sDir}`,
		`  task dir:    ${taskDir}`,
		`  inbox dir:   ${inbox}`,
		`The plan is FIXED and already APPROVED — read ${join(taskDir, "plan.md")} and DO NOT re-plan.`,
		``,
		`PROCEDURE (full-harness governance):`,
		`1. Load the "${loop.skill || "scheduled-loop"}" skill and the "autonomous-harness" skill.`,
		`2. Triage → implement the smallest verifiable units toward the goal.`,
		`3. After changes run the machine gate: ${loop.verifyCmd} — it MUST pass. Then spawn code-reviewer (write ${join(sDir, "review-marker.json")}) and grader for the audit (${join(sDir, "audit-marker.json")}).`,
		`4. Spawn the product-owner for the DONE verdict (it writes ${join(taskDir, "overseer.json")}). Flip progress criteria to done ONLY with evidence in ${join(taskDir, "progress.json")}.`,
		`5. Write significant work to memory (/workspace/.codeck/memory/daily/). For anything you could NOT safely resolve, write an ESCALATION markdown file to ${inbox}/ describing the issue and recommended action.`,
		``,
		`PERMISSION PROFILE — ${permissionProfileClause(loop.permissionProfile)}`,
		``,
		`Stop when the product-owner sets done (gate green + criteria complete) or the budget cap is hit. This is ONE bounded tick of a ${loop.mode} loop.`,
	].join("\n");

	return {
		prompt,
		extraEnv: { CODECK_HARNESS_DIR: hDir, CODECK_STATE_DIR: sDir },
		taskDir,
	};
}

/**
 * Read the harness outcome back from the isolated state after a loop tick so the
 * ExecutionResult carries accepted/escalated/costUsd for the acceptance metric.
 */
function readLoopOutcome(taskDir: string): { accepted: boolean; escalated: boolean; costUsd?: number } {
	let accepted = false, escalated = false, costUsd: number | undefined;
	try {
		const ov = JSON.parse(readFileSync(join(taskDir, "overseer.json"), "utf8"));
		const prog = JSON.parse(readFileSync(join(taskDir, "progress.json"), "utf8"));
		const crit = Array.isArray(prog.criteria) ? prog.criteria : Array.isArray(prog) ? prog : [];
		const allDone = crit.length > 0 && crit.every((c: any) => c.status === "done" && c.evidence);
		accepted = ov.done === true && allDone;
		escalated = ov.escalated === true;
	} catch { /* no overseer/progress — treat as not accepted */ }
	try {
		const bg = JSON.parse(readFileSync(join(taskDir, "budget.json"), "utf8"));
		if (typeof bg.spentUsd === "number" && Number.isFinite(bg.spentUsd)) costUsd = bg.spentUsd;
	} catch { /* no budget file */ }
	return { accepted, escalated, costUsd };
}

export function executeAgent(agentId: string, deps: ExecutorDeps): void {
	const runtime = deps.agents.get(agentId);
	if (!runtime) return;

	const executionId = randomUUID();
	const startedAt = Date.now();
	const timestamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");

	ensureOnboardingComplete();
	syncToClaudeSettings();

	const binary = getValidAgentBinary();
	const oauthEnv = getOAuthEnv();
	const cleanEnv = buildCleanEnv();

	// Load user env vars (API keys, tokens saved via Integrations UI)
	const agentUserEnv: Record<string, string> = {};
	const agentWsDir = join(process.env.WORKSPACE || "/workspace", ".codeck");
	const agentEncEnvPath = join(agentWsDir, ".env.encrypted");
	const agentDotenvPath = join(agentWsDir, ".env");

	if (existsSync(agentEncEnvPath)) {
		try {
			const store = JSON.parse(readFileSync(agentEncEnvPath, "utf-8"));
			for (const v of store.vars || []) {
				if (v.key && v.value) agentUserEnv[v.key] = decryptValue(v.value);
			}
		} catch {
			/* fall through to plaintext */
		}
	}
	if (Object.keys(agentUserEnv).length === 0 && existsSync(agentDotenvPath)) {
		try {
			const content = readFileSync(agentDotenvPath, "utf-8");
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
					if (key && val) agentUserEnv[key] = val;
				}
			}
		} catch {
			/* non-fatal */
		}
	}

	// Loop agents run the full PO-driven harness on an isolated control-plane;
	// everything else keeps the classic one-shot behaviour.
	const isLoop = runtime.config.kind === "loop" && !!runtime.config.loop;
	const loopRun = isLoop ? buildLoopRun(runtime, executionId, startedAt, deps) : null;

	const finalEnv = { ...cleanEnv, ...agentUserEnv, ...oauthEnv, TERM: "dumb", ...(loopRun?.extraEnv || {}) };

	const prompt = loopRun ? loopRun.prompt : runtime.config.objective;
	const cwd = deps.resolveAgentCwd(runtime.config.cwd);

	const spawnArgs = [
		"-p",
		prompt,
		"--output-format",
		"stream-json",
		"--verbose",
		"--no-session-persistence",
	];
	if (runtime.config.model) {
		spawnArgs.unshift("--model", runtime.config.model);
	}
	console.log(
		`[ProactiveAgents] Spawning: ${binary} (nice 10) ${spawnArgs.map((a) => (a.length > 80 ? a.slice(0, 77) + "..." : a)).join(" ")} (cwd: ${cwd})`,
	);

	runtime.outputBuffer = "";

	const child = spawn(binary, spawnArgs, {
		cwd,
		env: finalEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});
	// Lower CPU priority so the web UI stays responsive
	if (child.pid) {
		try {
			os.setPriority(child.pid, 10);
		} catch {
			/* non-fatal */
		}
	}

	runtime.currentExecution = child;
	console.log(`[ProactiveAgents] Agent ${agentId} PID: ${child.pid}`);

	deps.broadcastFn()({
		type: "agent:execution:start",
		data: { agentId, executionId },
	});

	// Prepare JSONL log file for raw stream data
	const execDir = deps.executionsDir(agentId);
	if (!existsSync(execDir))
		mkdirSync(execDir, { recursive: true, mode: 0o700 });
	const jsonlPath = join(execDir, `${timestamp}.jsonl`);

	// JSONL stream parser state
	let lineBuffer = "";
	let firstChunkReceived = false;
	let rawBytes = 0;
	let logBytesWritten = 0;
	let logTruncated = false;

	const onStdout = (data: Buffer) => {
		rawBytes += data.length;
		if (!firstChunkReceived) {
			firstChunkReceived = true;
			console.log(
				`[ProactiveAgents] Agent ${agentId} first output chunk received (${Date.now() - startedAt}ms)`,
			);
		}

		const chunk = data.toString();
		lineBuffer += chunk;

		// Append raw data to JSONL log (sanitize secrets before writing)
		// Enforce per-execution log size limit to prevent disk exhaustion
		if (!logTruncated) {
			const sanitized = sanitizeSecrets(chunk);
			if (logBytesWritten + sanitized.length > MAX_LOG_BYTES) {
				const warning = `\n[LOG TRUNCATED: Exceeded ${MAX_LOG_BYTES} byte limit (${Math.round(MAX_LOG_BYTES / 1024 / 1024)}MB)]\n`;
				appendFile(jsonlPath, warning, () => {});
				logTruncated = true;
				console.warn(
					`[ProactiveAgents] Agent ${agentId} log truncated at ${logBytesWritten} bytes`,
				);
			} else {
				appendFile(jsonlPath, sanitized, () => {});
				logBytesWritten += sanitized.length;
			}
		}

		// Process complete lines
		const lines = lineBuffer.split("\n");
		lineBuffer = lines.pop() || ""; // Keep incomplete last line in buffer

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			let text = extractTextFromStreamJson(trimmed);
			if (text) {
				// Strip leading newlines from very first output chunk
				if (runtime.outputBuffer.length === 0) text = text.replace(/^\n+/, "");
				if (text) {
					// SECURITY: outputBuffer is NOT sanitized — live output shown to authenticated
					// users during active execution. Sanitization applied on disk persistence.
					runtime.outputBuffer += text;
					deps.broadcastFn()({ type: "agent:output", data: { agentId, text } });
				}
			}
		}
	};

	const onStderr = (data: Buffer) => {
		const raw = data.toString();
		const sanitized = sanitizeSecrets(stripVTControlCharacters(raw));
		console.warn(
			`[ProactiveAgents] Agent ${agentId} stderr: ${sanitized.trim()}`,
		);
	};

	child.stdout?.on("data", onStdout);
	child.stderr?.on("data", onStderr);

	// Timeout — track state explicitly to avoid race conditions
	let timedOut = false;
	// SIGKILL grace period after SIGTERM. 15s default for Claude CLI cleanup (logs, API connections).
	// Configurable via AGENT_SIGKILL_GRACE_MS env var, clamped to 5–60 seconds.
	const rawGrace = parseInt(process.env.AGENT_SIGKILL_GRACE_MS || "15000", 10);
	const SIGKILL_GRACE_MS = Math.max(
		5000,
		Math.min(Number.isNaN(rawGrace) ? 15000 : rawGrace, 60000),
	);
	const timeoutHandle = setTimeout(() => {
		if (runtime.currentExecution === child) {
			timedOut = true;
			console.log(
				`[ProactiveAgents] Agent ${agentId} timed out after ${runtime.config.timeoutMs}ms`,
			);
			child.kill("SIGTERM");
			setTimeout(() => {
				if (runtime.currentExecution === child) child.kill("SIGKILL");
			}, SIGKILL_GRACE_MS);
		}
	}, runtime.config.timeoutMs);

	child.on("close", async (exitCode) => {
		clearTimeout(timeoutHandle);
		deps.cwdLocks.delete(cwd);
		runtime.currentExecution = null;

		// Process any remaining data in lineBuffer
		if (lineBuffer.trim()) {
			const text = extractTextFromStreamJson(lineBuffer.trim());
			if (text) {
				runtime.outputBuffer += text;
				deps.broadcastFn()({ type: "agent:output", data: { agentId, text } });
			}
		}

		const completedAt = Date.now();
		const durationMs = completedAt - startedAt;
		const succeeded = exitCode === 0 && !timedOut;

		const result: ExecutionResult = {
			executionId,
			agentId,
			startedAt,
			completedAt,
			durationMs,
			result: timedOut ? "timeout" : succeeded ? "success" : "failure",
			exitCode,
			outputLines: runtime.outputBuffer.split("\n").length,
			error: !succeeded ? `Exit code: ${exitCode}` : undefined,
		};

		// Loop tick — read the harness verdict back for the acceptance metric.
		if (loopRun) {
			const outcome = readLoopOutcome(loopRun.taskDir);
			result.kind = "loop";
			result.accepted = outcome.accepted;
			result.escalated = outcome.escalated;
			result.costUsd = outcome.costUsd;
		}

		// Save clean text log (sanitized, ANSI-stripped for defense-in-depth)
		const logPath = join(execDir, `${timestamp}.log`);
		const resultPath = join(execDir, `${timestamp}.result.json`);
		await writeFileAsync(
			logPath,
			sanitizeSecrets(stripVTControlCharacters(runtime.outputBuffer)),
		);
		await writeFileAsync(resultPath, JSON.stringify(result, null, 2));

		// Set restrictive file permissions on all execution files (owner read/write only)
		try {
			await chmodAsync(logPath, 0o600);
			await chmodAsync(resultPath, 0o600);
			if (existsSync(jsonlPath)) await chmodAsync(jsonlPath, 0o600);
		} catch {
			/* ignore permission errors */
		}

		// Prune old executions beyond retention limit
		deps.pruneExecutions(execDir);

		// Sync credentials after CLI execution — CLI may have refreshed/rewritten the token
		syncCredentialsAfterCLI();

		// Update state
		runtime.state.lastExecutionAt = completedAt;
		runtime.state.lastResult = result.result;
		runtime.state.totalExecutions++;

		if (succeeded) {
			runtime.state.consecutiveFailures = 0;
		} else {
			runtime.state.consecutiveFailures++;
			if (runtime.state.consecutiveFailures >= runtime.config.maxRetries) {
				console.log(
					`[ProactiveAgents] Agent ${agentId} auto-paused after ${runtime.state.consecutiveFailures} consecutive failures`,
				);
				runtime.state.status = "error";
				deps.stopCron(runtime);
			}
		}

		// Goal-driven loop: once the gate passes (accepted), stop firing — it reached
		// its objective. Scheduled loops keep their cadence.
		if (loopRun && runtime.config.loop?.mode === "goal-driven" && result.accepted) {
			runtime.state.status = "paused";
			deps.stopCron(runtime);
		}

		deps.saveState(agentId, runtime.state);

		deps.broadcastFn()({
			type: "agent:execution:complete",
			data: { agentId, executionId, result: result.result },
		});
		deps.broadcastFn()({ type: "agent:update", data: deps.toSummary(runtime) });

		console.log(
			`[ProactiveAgents] Agent ${agentId} execution complete: ${result.result} (exit: ${exitCode}, ${durationMs}ms, ${rawBytes} raw bytes, ${runtime.outputBuffer.length} text bytes)`,
		);

		deps.processCwdQueue(cwd);
	});

	child.on("error", async (err) => {
		clearTimeout(timeoutHandle);
		deps.cwdLocks.delete(cwd);
		runtime.currentExecution = null;

		const completedAt = Date.now();
		const result: ExecutionResult = {
			executionId,
			agentId,
			startedAt,
			completedAt,
			durationMs: completedAt - startedAt,
			result: "failure",
			exitCode: null,
			outputLines: 0,
			error: err.message,
		};

		if (!existsSync(execDir))
			mkdirSync(execDir, { recursive: true, mode: 0o700 });
		const errorResultPath = join(execDir, `${timestamp}.result.json`);
		await writeFileAsync(errorResultPath, JSON.stringify(result, null, 2));
		try {
			await chmodAsync(errorResultPath, 0o600);
		} catch {
			/* ignore */
		}

		runtime.state.lastExecutionAt = completedAt;
		runtime.state.lastResult = "failure";
		runtime.state.totalExecutions++;
		runtime.state.consecutiveFailures++;

		if (runtime.state.consecutiveFailures >= runtime.config.maxRetries) {
			runtime.state.status = "error";
			deps.stopCron(runtime);
		}

		deps.saveState(agentId, runtime.state);
		deps.broadcastFn()({
			type: "agent:execution:complete",
			data: { agentId, executionId, result: "failure" },
		});
		deps.broadcastFn()({ type: "agent:update", data: deps.toSummary(runtime) });

		console.log(
			`[ProactiveAgents] Agent ${agentId} execution error: ${err.message}`,
		);
		deps.processCwdQueue(cwd);
	});
}
