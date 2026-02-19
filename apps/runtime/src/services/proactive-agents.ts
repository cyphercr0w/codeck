import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, appendFileSync, statSync, chmodSync, renameSync } from 'fs';
import { resolve, join } from 'path';
import { randomUUID } from 'crypto';
import { stripVTControlCharacters } from 'util';
import cron from 'node-cron';
import { getValidAgentBinary, getOAuthEnv, ensureOnboardingComplete, buildCleanEnv } from './claude-env.js';
import { syncToClaudeSettings } from './permissions.js';
import { sanitizeSecrets } from './session-writer.js';
import { atomicWriteFileSync } from './memory.js';
import { syncCredentialsAfterCLI } from './auth-anthropic.js';

// ── Types ──

export type AgentStatus = 'active' | 'paused' | 'error';

export interface AgentConfig {
  id: string;
  name: string;
  objective: string;
  schedule: string;
  cwd: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentState {
  status: AgentStatus;
  consecutiveFailures: number;
  lastExecutionAt: number | null;
  lastResult: 'success' | 'failure' | 'timeout' | null;
  totalExecutions: number;
  nextRunAt: number | null;
}

export interface ExecutionResult {
  executionId: string;
  agentId: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  result: 'success' | 'failure' | 'timeout';
  exitCode: number | null;
  outputLines: number;
  error?: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  status: AgentStatus;
  schedule: string;
  objective: string;
  cwd: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  lastExecutionAt: number | null;
  lastResult: 'success' | 'failure' | 'timeout' | null;
  nextRunAt: number | null;
  totalExecutions: number;
  running: boolean;
}

export interface AgentDetail extends AgentSummary {
  consecutiveFailures: number;
  createdAt: number;
  updatedAt: number;
}

// ── Internal runtime state ──

interface AgentRuntime {
  config: AgentConfig;
  state: AgentState;
  cronJob: ReturnType<typeof cron.schedule> | null;
  currentExecution: ChildProcess | null;
  outputBuffer: string;
}

const agents = new Map<string, AgentRuntime>();
const cwdLocks = new Map<string, string>();       // cwd → agentId currently running
const cwdQueues = new Map<string, string[]>();     // cwd → queued agentIds
const MAX_AGENTS = 10;
const MAX_CONCURRENT = 2;
const MAX_EXECUTION_HISTORY = 100;
const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50MB per-execution log size limit

const AGENTS_DIR = resolve(process.env.WORKSPACE || '/workspace', '.codeck/agents');
const MANIFEST_PATH = join(AGENTS_DIR, 'manifest.json');

type BroadcastFn = (msg: object) => void;
let broadcastFn: BroadcastFn = () => {};

// ── Filesystem helpers ──

function ensureAgentsDir(): void {
  if (!existsSync(AGENTS_DIR)) mkdirSync(AGENTS_DIR, { recursive: true });
}

function agentDir(id: string): string {
  return join(AGENTS_DIR, id);
}

function executionsDir(id: string): string {
  return join(agentDir(id), 'executions');
}

const MANIFEST_BACKUP_PATH = `${MANIFEST_PATH}.backup`;

function saveManifest(): void {
  // Backup old manifest before overwrite
  if (existsSync(MANIFEST_PATH)) {
    try { renameSync(MANIFEST_PATH, MANIFEST_BACKUP_PATH); } catch { /* ignore */ }
  }
  const ids = Array.from(agents.keys());
  atomicWriteFileSync(MANIFEST_PATH, JSON.stringify({ version: 1, agents: ids }, null, 2));
}

function saveConfig(config: AgentConfig): void {
  const dir = agentDir(config.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

function saveState(id: string, state: AgentState): void {
  const dir = agentDir(id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

function isValidConfig(raw: unknown): raw is AgentConfig {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string' &&
    typeof o.objective === 'string' && typeof o.schedule === 'string' &&
    typeof o.cwd === 'string' && typeof o.timeoutMs === 'number' &&
    typeof o.maxRetries === 'number' && typeof o.createdAt === 'number' &&
    typeof o.updatedAt === 'number';
}

function isValidState(raw: unknown): raw is AgentState {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return typeof o.status === 'string' &&
    ['active', 'paused', 'error'].includes(o.status as string) &&
    typeof o.consecutiveFailures === 'number' &&
    typeof o.totalExecutions === 'number';
}

function loadConfig(id: string): AgentConfig | null {
  const filePath = join(agentDir(id), 'config.json');
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!isValidConfig(raw)) {
      console.error(`[ProactiveAgents] Invalid config schema for agent ${id}`);
      return null;
    }
    return raw;
  } catch (e) {
    console.error(`[ProactiveAgents] Failed to load config ${id}:`, (e as Error).message);
    return null;
  }
}

function loadState(id: string): AgentState | null {
  const filePath = join(agentDir(id), 'state.json');
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!isValidState(raw)) {
      console.error(`[ProactiveAgents] Invalid state schema for agent ${id}`);
      return null;
    }
    return raw;
  } catch (e) {
    console.error(`[ProactiveAgents] Failed to load state ${id}:`, (e as Error).message);
    return null;
  }
}

function pruneExecutions(execDir: string): void {
  try {
    const resultFiles = readdirSync(execDir)
      .filter(f => f.endsWith('.result.json'))
      .sort()
      .reverse();
    if (resultFiles.length <= MAX_EXECUTION_HISTORY) return;
    const toDelete = resultFiles.slice(MAX_EXECUTION_HISTORY);
    for (const f of toDelete) {
      const base = f.replace('.result.json', '');
      rmSync(join(execDir, `${base}.jsonl`), { force: true });
      rmSync(join(execDir, `${base}.log`), { force: true });
      rmSync(join(execDir, f), { force: true });
    }
    console.log(`[ProactiveAgents] Pruned ${toDelete.length} old executions from ${execDir}`);
  } catch { /* ignore prune errors */ }
}

// ── Cron helpers ──

/**
 * Compute the next cron run time from a cron expression.
 * Parses the cron fields and finds the next matching minute.
 */
function computeNextRun(schedule: string): number | null {
  if (!cron.validate(schedule)) return null;
  try {
    const parts = schedule.trim().split(/\s+/);
    if (parts.length < 5) return null;

    const now = new Date();
    // Start from the next minute
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    // Try up to 525600 minutes (1 year) to find a match
    for (let i = 0; i < 525600; i++) {
      const min = candidate.getMinutes();
      const hour = candidate.getHours();
      const dom = candidate.getDate();
      const month = candidate.getMonth() + 1;
      const dow = candidate.getDay();

      if (
        matchesCronField(parts[0], min, 0, 59) &&
        matchesCronField(parts[1], hour, 0, 23) &&
        matchesCronField(parts[2], dom, 1, 31) &&
        matchesCronField(parts[3], month, 1, 12) &&
        matchesCronField(parts[4], dow, 0, 7)
      ) {
        return candidate.getTime();
      }
      candidate.setMinutes(candidate.getMinutes() + 1);
    }
    return null;
  } catch { return null; }
}

function matchesCronField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr);
      const start = range === '*' ? min : parseInt(range);
      if (!isNaN(step) && !isNaN(start)) {
        for (let v = start; v <= max; v += step) {
          if (v === value) return true;
        }
      }
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
    } else {
      if (parseInt(part) === value) return true;
      // Handle day-of-week 7 === 0 (Sunday)
      if (max === 7 && parseInt(part) === 0 && value === 7) return true;
      if (max === 7 && parseInt(part) === 7 && value === 0) return true;
    }
  }
  return false;
}

function scheduleCron(runtime: AgentRuntime): void {
  if (runtime.cronJob) {
    runtime.cronJob.stop();
    runtime.cronJob = null;
  }
  if (runtime.state.status !== 'active') return;

  runtime.cronJob = cron.schedule(runtime.config.schedule, () => {
    enqueueExecution(runtime.config.id);
    // Update nextRunAt after each trigger
    runtime.state.nextRunAt = computeNextRun(runtime.config.schedule);
    saveState(runtime.config.id, runtime.state);
    broadcastFn({ type: 'agent:update', data: toSummary(runtime) });
  });

  runtime.state.nextRunAt = computeNextRun(runtime.config.schedule);
  saveState(runtime.config.id, runtime.state);
}

function stopCron(runtime: AgentRuntime): void {
  if (runtime.cronJob) {
    runtime.cronJob.stop();
    runtime.cronJob = null;
  }
  runtime.state.nextRunAt = null;
}

// ── Execution engine ──

function enqueueExecution(agentId: string): void {
  const runtime = agents.get(agentId);
  if (!runtime) return;
  if (runtime.state.status !== 'active') return;
  if (runtime.currentExecution) {
    console.log(`[ProactiveAgents] Agent ${agentId} already running, skipping`);
    return;
  }

  const cwd = runtime.config.cwd;

  if (cwdLocks.has(cwd)) {
    const queue = cwdQueues.get(cwd) || [];
    if (!queue.includes(agentId)) {
      queue.push(agentId);
      cwdQueues.set(cwd, queue);
      console.log(`[ProactiveAgents] Agent ${agentId} queued for cwd ${cwd} (${queue.length} in queue)`);
    }
    return;
  }

  cwdLocks.set(cwd, agentId);
  executeAgent(agentId);
}

function processCwdQueue(cwd: string): void {
  const queue = cwdQueues.get(cwd);
  if (!queue || queue.length === 0) {
    cwdQueues.delete(cwd);
    return;
  }

  const nextId = queue.shift()!;
  if (queue.length === 0) cwdQueues.delete(cwd);

  const runtime = agents.get(nextId);
  if (runtime && runtime.state.status === 'active' && !runtime.currentExecution) {
    cwdLocks.set(cwd, nextId);
    executeAgent(nextId);
  } else {
    // Skip invalid entry, try next
    processCwdQueue(cwd);
  }
}

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

function executeAgent(agentId: string): void {
  const runtime = agents.get(agentId);
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
  const cwd = runtime.config.cwd;

  const spawnArgs = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
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

  broadcastFn({ type: 'agent:execution:start', data: { agentId, executionId } });

  // Prepare JSONL log file for raw stream data
  const execDir = executionsDir(agentId);
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
        try { appendFileSync(jsonlPath, warning); } catch { /* ignore */ }
        logTruncated = true;
        console.warn(`[ProactiveAgents] Agent ${agentId} log truncated at ${logBytesWritten} bytes`);
      } else {
        try {
          appendFileSync(jsonlPath, sanitized);
          logBytesWritten += sanitized.length;
        } catch { /* ignore */ }
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
          // users during active execution. Sanitization applied on disk persistence (line 457).
          runtime.outputBuffer += text;
          broadcastFn({ type: 'agent:output', data: { agentId, text } });
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

  child.on('close', (exitCode) => {
    clearTimeout(timeoutHandle);
    cwdLocks.delete(cwd);
    runtime.currentExecution = null;

    // Process any remaining data in lineBuffer
    if (lineBuffer.trim()) {
      const text = extractTextFromStreamJson(lineBuffer.trim());
      if (text) {
        runtime.outputBuffer += text;
        broadcastFn({ type: 'agent:output', data: { agentId, text } });
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
    writeFileSync(logPath, sanitizeSecrets(stripVTControlCharacters(runtime.outputBuffer)));
    writeFileSync(resultPath, JSON.stringify(result, null, 2));

    // Set restrictive file permissions on all execution files (owner read/write only)
    try {
      chmodSync(logPath, 0o600);
      chmodSync(resultPath, 0o600);
      if (existsSync(jsonlPath)) chmodSync(jsonlPath, 0o600);
    } catch { /* ignore permission errors */ }

    // Prune old executions beyond retention limit
    pruneExecutions(execDir);

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
        stopCron(runtime);
      }
    }

    saveState(agentId, runtime.state);

    broadcastFn({ type: 'agent:execution:complete', data: { agentId, executionId, result: result.result } });
    broadcastFn({ type: 'agent:update', data: toSummary(runtime) });

    console.log(`[ProactiveAgents] Agent ${agentId} execution complete: ${result.result} (exit: ${exitCode}, ${durationMs}ms, ${rawBytes} raw bytes, ${runtime.outputBuffer.length} text bytes)`);

    processCwdQueue(cwd);
  });

  child.on('error', (err) => {
    clearTimeout(timeoutHandle);
    cwdLocks.delete(cwd);
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
    writeFileSync(errorResultPath, JSON.stringify(result, null, 2));
    try { chmodSync(errorResultPath, 0o600); } catch { /* ignore */ }

    runtime.state.lastExecutionAt = completedAt;
    runtime.state.lastResult = 'failure';
    runtime.state.totalExecutions++;
    runtime.state.consecutiveFailures++;

    if (runtime.state.consecutiveFailures >= runtime.config.maxRetries) {
      runtime.state.status = 'error';
      stopCron(runtime);
    }

    saveState(agentId, runtime.state);
    broadcastFn({ type: 'agent:execution:complete', data: { agentId, executionId, result: 'failure' } });
    broadcastFn({ type: 'agent:update', data: toSummary(runtime) });

    console.log(`[ProactiveAgents] Agent ${agentId} execution error: ${err.message}`);
    processCwdQueue(cwd);
  });
}

// ── Serialization helpers ──

function toSummary(runtime: AgentRuntime): AgentSummary {
  return {
    id: runtime.config.id,
    name: runtime.config.name,
    status: runtime.state.status,
    schedule: runtime.config.schedule,
    objective: runtime.config.objective,
    cwd: runtime.config.cwd,
    model: runtime.config.model || '',
    timeoutMs: runtime.config.timeoutMs,
    maxRetries: runtime.config.maxRetries,
    lastExecutionAt: runtime.state.lastExecutionAt,
    lastResult: runtime.state.lastResult,
    nextRunAt: runtime.state.nextRunAt,
    totalExecutions: runtime.state.totalExecutions,
    running: runtime.currentExecution !== null,
  };
}

function toDetail(runtime: AgentRuntime): AgentDetail {
  return {
    ...toSummary(runtime),
    consecutiveFailures: runtime.state.consecutiveFailures,
    createdAt: runtime.config.createdAt,
    updatedAt: runtime.config.updatedAt,
  };
}

// ── Objective linting ──

interface ObjectiveLintWarning {
  description: string;
  severity: 'high' | 'medium';
}

const SUSPICIOUS_PATTERNS: Array<{ pattern: RegExp; description: string; severity: 'high' | 'medium' }> = [
  { pattern: /docker\s+run.*--privileged/i, description: 'Privileged container spawn (grants host root access)', severity: 'high' },
  { pattern: /nsenter.*-t\s*1/i, description: 'Host namespace entry (container escape technique)', severity: 'high' },
  { pattern: /chroot\s+\/host/i, description: 'Host filesystem chroot (container escape)', severity: 'high' },
  { pattern: /docker\s+run.*-v\s+\/:/i, description: 'Host root filesystem mount', severity: 'high' },
  { pattern: /docker\s+run.*--pid[= ]host/i, description: 'Host PID namespace (container escape)', severity: 'high' },
  { pattern: /docker\s+run.*--network[= ]host/i, description: 'Host network namespace access', severity: 'medium' },
  { pattern: /docker\s+exec/i, description: 'Exec into container (lateral movement)', severity: 'medium' },
];

export function lintAgentObjective(objective: string): ObjectiveLintWarning[] {
  const warnings: ObjectiveLintWarning[] = [];
  for (const { pattern, description, severity } of SUSPICIOUS_PATTERNS) {
    if (pattern.test(objective)) {
      warnings.push({ description, severity });
    }
  }
  return warnings;
}

// ── Lifecycle ──

function loadManifest(): { version: number; agents: string[] } {
  const tryPaths = [MANIFEST_PATH, MANIFEST_BACKUP_PATH];

  for (const p of tryPaths) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      if (typeof raw.version === 'number' && Array.isArray(raw.agents)) {
        if (p !== MANIFEST_PATH) {
          console.warn(`[ProactiveAgents] Recovered manifest from backup`);
        }
        return raw;
      }
    } catch (e) {
      console.warn(`[ProactiveAgents] Failed to parse ${p}:`, (e as Error).message);
    }
  }

  // Both failed — scan directory for recovery
  console.warn('[ProactiveAgents] Manifest corrupt/missing, scanning directory for agents...');
  return recoverManifestFromDisk();
}

function recoverManifestFromDisk(): { version: 1; agents: string[] } {
  if (!existsSync(AGENTS_DIR)) return { version: 1, agents: [] };
  const agentDirs = readdirSync(AGENTS_DIR)
    .filter(name => !name.startsWith('.') && existsSync(join(AGENTS_DIR, name, 'config.json')));
  console.log(`[ProactiveAgents] Recovered ${agentDirs.length} agents from disk scan`);
  return { version: 1, agents: agentDirs };
}

export function initProactiveAgents(broadcast: BroadcastFn): void {
  broadcastFn = broadcast;
  ensureAgentsDir();

  // Load manifest with backup fallback and directory scan recovery
  const manifest = loadManifest();
  const agentIds: string[] = manifest.agents;

  if (agentIds.length === 0) {
    // Persist empty manifest if none exists
    if (!existsSync(MANIFEST_PATH)) {
      atomicWriteFileSync(MANIFEST_PATH, JSON.stringify({ version: 1, agents: [] }, null, 2));
      console.log('[ProactiveAgents] Initialized empty manifest');
    }
    return;
  }

  for (const id of agentIds) {
    const config = loadConfig(id);
    const state = loadState(id);
    if (!config || !state) {
      console.warn(`[ProactiveAgents] Skipping agent ${id}: missing or invalid config/state`);
      continue;
    }

    const runtime: AgentRuntime = {
      config,
      state,
      cronJob: null,
      currentExecution: null,
      outputBuffer: '',
    };

    agents.set(id, runtime);

    if (state.status === 'active') {
      // Detect missed runs before rescheduling
      if (state.nextRunAt && state.nextRunAt < Date.now()) {
        const missedMinutes = Math.round((Date.now() - state.nextRunAt) / 60000);
        console.warn(`[ProactiveAgents] Agent ${id} (${config.name}) missed scheduled run by ${missedMinutes} minutes`);
        broadcastFn({ type: 'agent:misfire', data: { agentId: id, name: config.name, missedByMinutes: missedMinutes } });
      }
      scheduleCron(runtime);
    }

    console.log(`[ProactiveAgents] Restored agent: ${config.name} (${id}, ${state.status})`);
  }

  console.log(`[ProactiveAgents] Loaded ${agents.size} agents`);
}

export function shutdownProactiveAgents(): void {
  for (const [id, runtime] of agents) {
    stopCron(runtime);
    if (runtime.currentExecution) {
      runtime.currentExecution.kill('SIGTERM');
      console.log(`[ProactiveAgents] Killed running execution for agent ${id}`);
    }
    saveState(id, runtime.state);
  }
  console.log(`[ProactiveAgents] Shutdown complete (${agents.size} agents)`);
}

// ── CRUD ──

export interface CreateAgentInput {
  name: string;
  objective: string;
  schedule: string;
  cwd?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export function createAgent(input: CreateAgentInput): AgentDetail {
  if (agents.size >= MAX_AGENTS) {
    throw new Error(`Maximum ${MAX_AGENTS} agents allowed`);
  }

  if (!input.name || !input.objective || !input.schedule) {
    throw new Error('name, objective, and schedule are required');
  }

  if (input.name.length > 50) {
    throw new Error('Agent name must not exceed 50 characters');
  }

  if (input.objective.length > 10000) {
    throw new Error('Objective must be under 10,000 characters');
  }

  if (!cron.validate(input.schedule)) {
    throw new Error(`Invalid cron expression: ${input.schedule}`);
  }

  const cwd = input.cwd?.trim() || process.env.WORKSPACE || '/workspace';
  if (!existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Working directory must be a directory, not a file: ${cwd}`);
  }

  // Lint objective for suspicious Docker patterns
  const lintWarnings = lintAgentObjective(input.objective);
  if (lintWarnings.length > 0) {
    console.warn(`[ProactiveAgents] Agent objective contains suspicious patterns: ${JSON.stringify(lintWarnings)}`);
  }

  const id = randomUUID().slice(0, 8);
  const now = Date.now();

  const config: AgentConfig = {
    id,
    name: input.name,
    objective: input.objective,
    schedule: input.schedule,
    cwd,
    model: input.model || '',
    timeoutMs: input.timeoutMs || 300000, // 5 minutes default
    maxRetries: input.maxRetries || 3,
    createdAt: now,
    updatedAt: now,
  };

  const state: AgentState = {
    status: 'active',
    consecutiveFailures: 0,
    lastExecutionAt: null,
    lastResult: null,
    totalExecutions: 0,
    nextRunAt: null,
  };

  // Persist
  const dir = agentDir(id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(executionsDir(id), { recursive: true, mode: 0o700 });
  saveConfig(config);
  saveState(id, state);

  const runtime: AgentRuntime = {
    config,
    state,
    cronJob: null,
    currentExecution: null,
    outputBuffer: '',
  };

  agents.set(id, runtime);
  saveManifest();
  scheduleCron(runtime);

  console.log(`[ProactiveAgents] Created agent: ${config.name} (${id}, schedule=${config.schedule})`);
  broadcastFn({ type: 'agent:update', data: toSummary(runtime) });

  return toDetail(runtime);
}

export function getAgent(id: string): AgentDetail | null {
  const runtime = agents.get(id);
  return runtime ? toDetail(runtime) : null;
}

export function listAgents(): AgentSummary[] {
  return Array.from(agents.values()).map(toSummary);
}

export function updateAgent(id: string, updates: Partial<Pick<AgentConfig, 'name' | 'objective' | 'schedule' | 'cwd' | 'model' | 'timeoutMs' | 'maxRetries'>>): AgentDetail | null {
  const runtime = agents.get(id);
  if (!runtime) return null;

  if (updates.name && updates.name.length > 50) {
    throw new Error('Agent name must not exceed 50 characters');
  }

  if (updates.objective && updates.objective.length > 10000) {
    throw new Error('Objective must be under 10,000 characters');
  }

  if (updates.schedule && !cron.validate(updates.schedule)) {
    throw new Error(`Invalid cron expression: ${updates.schedule}`);
  }

  if (updates.cwd && !existsSync(updates.cwd)) {
    throw new Error(`Working directory does not exist: ${updates.cwd}`);
  }

  // Lint updated objective for suspicious Docker patterns
  if (updates.objective) {
    const lintWarnings = lintAgentObjective(updates.objective);
    if (lintWarnings.length > 0) {
      console.warn(`[ProactiveAgents] Updated objective for agent ${id} contains suspicious patterns: ${JSON.stringify(lintWarnings)}`);
    }
  }

  const scheduleChanged = updates.schedule && updates.schedule !== runtime.config.schedule;

  Object.assign(runtime.config, updates, { updatedAt: Date.now() });
  saveConfig(runtime.config);

  if (scheduleChanged && runtime.state.status === 'active') {
    scheduleCron(runtime);
  }

  broadcastFn({ type: 'agent:update', data: toSummary(runtime) });
  return toDetail(runtime);
}

export function deleteAgent(id: string): boolean {
  const runtime = agents.get(id);
  if (!runtime) return false;

  stopCron(runtime);
  if (runtime.currentExecution) {
    runtime.currentExecution.kill('SIGTERM');
  }

  agents.delete(id);
  saveManifest();

  // Remove files
  const dir = agentDir(id);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`[ProactiveAgents] Deleted agent: ${runtime.config.name} (${id})`);
  return true;
}

// ── Lifecycle controls ──

export function pauseAgent(id: string): AgentDetail | null {
  const runtime = agents.get(id);
  if (!runtime) return null;

  runtime.state.status = 'paused';
  stopCron(runtime);
  saveState(id, runtime.state);

  broadcastFn({ type: 'agent:update', data: toSummary(runtime) });
  console.log(`[ProactiveAgents] Paused agent: ${runtime.config.name} (${id})`);
  return toDetail(runtime);
}

export function resumeAgent(id: string): AgentDetail | null {
  const runtime = agents.get(id);
  if (!runtime) return null;

  runtime.state.status = 'active';
  runtime.state.consecutiveFailures = 0;
  scheduleCron(runtime);
  saveState(id, runtime.state);

  broadcastFn({ type: 'agent:update', data: toSummary(runtime) });
  console.log(`[ProactiveAgents] Resumed agent: ${runtime.config.name} (${id})`);
  return toDetail(runtime);
}

export function triggerAgent(id: string): { executionId: string } | null {
  const runtime = agents.get(id);
  if (!runtime) return null;

  if (runtime.currentExecution) {
    throw new Error('Agent is already executing');
  }

  // Temporarily set active if paused/error for manual trigger
  const wasStatus = runtime.state.status;
  if (runtime.state.status !== 'active') {
    runtime.state.status = 'active';
  }

  enqueueExecution(id);

  // Restore status if it was not active and we didn't actually start
  if (wasStatus !== 'active' && !runtime.currentExecution) {
    runtime.state.status = wasStatus;
  }

  return { executionId: 'queued' };
}

// ── Queries ──

export function getAgentOutput(id: string): string | null {
  const runtime = agents.get(id);
  if (!runtime) return null;
  return runtime.outputBuffer || null;
}

export function getAgentLogs(id: string, timestamp?: string): string | null {
  const runtime = agents.get(id);
  if (!runtime) return null;

  const dir = executionsDir(id);
  if (!existsSync(dir)) return null;

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.log'))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  // If timestamp provided, find matching log file
  if (timestamp) {
    const prefix = new Date(parseInt(timestamp)).toISOString().replace(/[:.]/g, '-');
    const match = files.find(f => f.startsWith(prefix));
    if (!match) return null;
    try {
      return readFileSync(join(dir, match), 'utf8');
    } catch { return null; }
  }

  try {
    return readFileSync(join(dir, files[0]), 'utf8');
  } catch { return null; }
}

export function getAgentExecutions(id: string, limit = 20): ExecutionResult[] {
  const dir = executionsDir(id);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.result.json'))
    .sort()
    .reverse()
    .slice(0, limit);

  const results: ExecutionResult[] = [];
  for (const f of files) {
    try {
      results.push(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    } catch (e) {
      console.warn(`[ProactiveAgents] Skipping corrupt execution result: ${f} — ${(e as Error).message}`);
    }
  }

  return results;
}
