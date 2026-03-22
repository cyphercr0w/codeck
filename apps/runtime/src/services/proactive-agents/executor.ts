import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, appendFile } from 'fs';
import { writeFile as writeFileAsync, chmod as chmodAsync } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { stripVTControlCharacters } from 'util';
import { getValidAgentBinary, getOAuthEnv, ensureOnboardingComplete, buildCleanEnv } from '../claude-env.js';
import { syncToClaudeSettings } from '../permissions.js';
import { sanitizeSecrets } from '../session-writer.js';
import { syncCredentialsAfterCLI } from '../auth-anthropic.js';
import type { AgentRuntime, ExecutionResult, BroadcastFn } from './types.js';

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
    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      const text = obj.message.content
        .filter((b: any) => b.type === 'text' && b.text)
        .map((b: any) => b.text)
        .join('');
      return text ? text + '\n' : '';
    }
    // content_block_delta with text delta (streaming chunks)
    if (obj.type === 'content_block_delta' && obj.delta?.text) {
      return obj.delta.text;
    }
    // result message (final summary)
    if (obj.type === 'result' && typeof obj.result === 'string') {
      return '\n' + obj.result + '\n';
    }
    return '';
  } catch {
    return '';
  }
}

// ── Execution engine ──

export interface ExecutorDeps {
  agents: Map<string, AgentRuntime>;
  cwdLocks: Map<string, string>;
  broadcastFn: () => BroadcastFn;
  resolveAgentCwd: (cwd: string) => string;
  executionsDir: (id: string) => string;
  saveState: (id: string, state: AgentRuntime['state']) => void;
  stopCron: (runtime: AgentRuntime) => void;
  toSummary: (runtime: AgentRuntime) => object;
  pruneExecutions: (execDir: string) => void;
  processCwdQueue: (cwd: string) => void;
}

export function executeAgent(agentId: string, deps: ExecutorDeps): void {
  const runtime = deps.agents.get(agentId);
  if (!runtime) return;

  const executionId = randomUUID();
  const startedAt = Date.now();
  const timestamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');

  ensureOnboardingComplete();
  syncToClaudeSettings();

  const binary = getValidAgentBinary();
  const oauthEnv = getOAuthEnv();
  const cleanEnv = buildCleanEnv();
  const finalEnv = { ...cleanEnv, ...oauthEnv, TERM: 'dumb' };

  const prompt = runtime.config.objective;
  const cwd = deps.resolveAgentCwd(runtime.config.cwd);

  const spawnArgs = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
  if (runtime.config.model) {
    spawnArgs.unshift('--model', runtime.config.model);
  }
  console.log(`[ProactiveAgents] Spawning: ${binary} ${spawnArgs.map(a => a.length > 80 ? a.slice(0, 77) + '...' : a).join(' ')} (cwd: ${cwd})`);

  runtime.outputBuffer = '';

  const child = spawn(binary, spawnArgs, {
    cwd,
    env: finalEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  runtime.currentExecution = child;
  console.log(`[ProactiveAgents] Agent ${agentId} PID: ${child.pid}`);

  deps.broadcastFn()({ type: 'agent:execution:start', data: { agentId, executionId } });

  // Prepare JSONL log file for raw stream data
  const execDir = deps.executionsDir(agentId);
  if (!existsSync(execDir)) mkdirSync(execDir, { recursive: true, mode: 0o700 });
  const jsonlPath = join(execDir, `${timestamp}.jsonl`);

  // JSONL stream parser state
  let lineBuffer = '';
  let firstChunkReceived = false;
  let rawBytes = 0;
  let logBytesWritten = 0;
  let logTruncated = false;

  const onStdout = (data: Buffer) => {
    rawBytes += data.length;
    if (!firstChunkReceived) {
      firstChunkReceived = true;
      console.log(`[ProactiveAgents] Agent ${agentId} first output chunk received (${Date.now() - startedAt}ms)`);
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
        console.warn(`[ProactiveAgents] Agent ${agentId} log truncated at ${logBytesWritten} bytes`);
      } else {
        appendFile(jsonlPath, sanitized, () => {});
        logBytesWritten += sanitized.length;
      }
    }

    // Process complete lines
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || ''; // Keep incomplete last line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let text = extractTextFromStreamJson(trimmed);
      if (text) {
        // Strip leading newlines from very first output chunk
        if (runtime.outputBuffer.length === 0) text = text.replace(/^\n+/, '');
        if (text) {
          // SECURITY: outputBuffer is NOT sanitized — live output shown to authenticated
          // users during active execution. Sanitization applied on disk persistence.
          runtime.outputBuffer += text;
          deps.broadcastFn()({ type: 'agent:output', data: { agentId, text } });
        }
      }
    }
  };

  const onStderr = (data: Buffer) => {
    const raw = data.toString();
    const sanitized = sanitizeSecrets(stripVTControlCharacters(raw));
    console.warn(`[ProactiveAgents] Agent ${agentId} stderr: ${sanitized.trim()}`);
  };

  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);

  // Timeout — track state explicitly to avoid race conditions
  let timedOut = false;
  // SIGKILL grace period after SIGTERM. 15s default for Claude CLI cleanup (logs, API connections).
  // Configurable via AGENT_SIGKILL_GRACE_MS env var, clamped to 5–60 seconds.
  const rawGrace = parseInt(process.env.AGENT_SIGKILL_GRACE_MS || '15000', 10);
  const SIGKILL_GRACE_MS = Math.max(5000, Math.min(Number.isNaN(rawGrace) ? 15000 : rawGrace, 60000));
  const timeoutHandle = setTimeout(() => {
    if (runtime.currentExecution === child) {
      timedOut = true;
      console.log(`[ProactiveAgents] Agent ${agentId} timed out after ${runtime.config.timeoutMs}ms`);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (runtime.currentExecution === child) child.kill('SIGKILL');
      }, SIGKILL_GRACE_MS);
    }
  }, runtime.config.timeoutMs);

  child.on('close', async (exitCode) => {
    clearTimeout(timeoutHandle);
    deps.cwdLocks.delete(cwd);
    runtime.currentExecution = null;

    // Process any remaining data in lineBuffer
    if (lineBuffer.trim()) {
      const text = extractTextFromStreamJson(lineBuffer.trim());
      if (text) {
        runtime.outputBuffer += text;
        deps.broadcastFn()({ type: 'agent:output', data: { agentId, text } });
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
      result: timedOut ? 'timeout' : (succeeded ? 'success' : 'failure'),
      exitCode,
      outputLines: runtime.outputBuffer.split('\n').length,
      error: !succeeded ? `Exit code: ${exitCode}` : undefined,
    };

    // Save clean text log (sanitized, ANSI-stripped for defense-in-depth)
    const logPath = join(execDir, `${timestamp}.log`);
    const resultPath = join(execDir, `${timestamp}.result.json`);
    await writeFileAsync(logPath, sanitizeSecrets(stripVTControlCharacters(runtime.outputBuffer)));
    await writeFileAsync(resultPath, JSON.stringify(result, null, 2));

    // Set restrictive file permissions on all execution files (owner read/write only)
    try {
      await chmodAsync(logPath, 0o600);
      await chmodAsync(resultPath, 0o600);
      if (existsSync(jsonlPath)) await chmodAsync(jsonlPath, 0o600);
    } catch { /* ignore permission errors */ }

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
        console.log(`[ProactiveAgents] Agent ${agentId} auto-paused after ${runtime.state.consecutiveFailures} consecutive failures`);
        runtime.state.status = 'error';
        deps.stopCron(runtime);
      }
    }

    deps.saveState(agentId, runtime.state);

    deps.broadcastFn()({ type: 'agent:execution:complete', data: { agentId, executionId, result: result.result } });
    deps.broadcastFn()({ type: 'agent:update', data: deps.toSummary(runtime) });

    console.log(`[ProactiveAgents] Agent ${agentId} execution complete: ${result.result} (exit: ${exitCode}, ${durationMs}ms, ${rawBytes} raw bytes, ${runtime.outputBuffer.length} text bytes)`);

    deps.processCwdQueue(cwd);
  });

  child.on('error', async (err) => {
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
      result: 'failure',
      exitCode: null,
      outputLines: 0,
      error: err.message,
    };

    if (!existsSync(execDir)) mkdirSync(execDir, { recursive: true, mode: 0o700 });
    const errorResultPath = join(execDir, `${timestamp}.result.json`);
    await writeFileAsync(errorResultPath, JSON.stringify(result, null, 2));
    try { await chmodAsync(errorResultPath, 0o600); } catch { /* ignore */ }

    runtime.state.lastExecutionAt = completedAt;
    runtime.state.lastResult = 'failure';
    runtime.state.totalExecutions++;
    runtime.state.consecutiveFailures++;

    if (runtime.state.consecutiveFailures >= runtime.config.maxRetries) {
      runtime.state.status = 'error';
      deps.stopCron(runtime);
    }

    deps.saveState(agentId, runtime.state);
    deps.broadcastFn()({ type: 'agent:execution:complete', data: { agentId, executionId, result: 'failure' } });
    deps.broadcastFn()({ type: 'agent:update', data: deps.toSummary(runtime) });

    console.log(`[ProactiveAgents] Agent ${agentId} execution error: ${err.message}`);
    deps.processCwdQueue(cwd);
  });
}
