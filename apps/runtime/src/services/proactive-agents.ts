import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, renameSync } from 'fs';
import { resolve, join, isAbsolute } from 'path';
import { randomUUID } from 'crypto';
import cron from 'node-cron';
import { atomicWriteFileSync } from './memory.js';

// ── Sub-module imports ──
import { scheduleCron, stopCron, enqueueExecution, type SchedulerDeps } from './proactive-agents/scheduler.js';
import { getAgentOutput as _getAgentOutput, getAgentLogs as _getAgentLogs, getAgentExecutions as _getAgentExecutions } from './proactive-agents/logs.js';

// ── Re-export types ──
export type { AgentStatus, AgentConfig, AgentState, ExecutionResult, AgentSummary, AgentDetail, CreateAgentInput, ObjectiveLintWarning, BroadcastFn, AgentKind, LoopConfig, LoopMode, PermissionProfile, LoopAcceptance, InboxEntry } from './proactive-agents/types.js';
import type { AgentRuntime, AgentState, AgentConfig, ExecutionResult, AgentSummary, AgentDetail, CreateAgentInput, BroadcastFn, AgentKind, LoopConfig, LoopMode, PermissionProfile, LoopAcceptance, InboxEntry } from './proactive-agents/types.js';

// ── Internal runtime state ──

const agents = new Map<string, AgentRuntime>();
const cwdLocks = new Map<string, string>();       // cwd → agentId currently running
const cwdQueues = new Map<string, string[]>();     // cwd → queued agentIds
const MAX_AGENTS = 10;
const MAX_EXECUTION_HISTORY = 100;

// ── Loop (scheduled-loop) defaults & bounds ──
// A full-harness tick (plan→implement→review→audit→DONE) needs far more wall-clock
// than a one-shot run, so loops default to a much larger timeout.
const LOOP_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;   // 30 min
const LOOP_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;   // 2 h hard ceiling
const LOOP_DEFAULT_ITER_CAP = 200;
const LOOP_DEFAULT_COST_CAP_USD = 5;
const MAX_INBOX_ENTRIES = 200;

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' ? Math.round(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(n, hi));
}

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(n, hi));
}

/**
 * Normalize + validate a loop config from user input. Throws on missing gate.
 * A loop is only legitimate if a machine can say pass/fail — enforce goal + verifyCmd.
 */
function buildLoopConfig(raw: Partial<LoopConfig> | undefined): LoopConfig {
  const l = raw || {};
  if (!l.goal || typeof l.goal !== 'string' || !l.goal.trim()) {
    throw new Error('Loop agents require a goal (an observable stop condition)');
  }
  if (!l.verifyCmd || typeof l.verifyCmd !== 'string' || !l.verifyCmd.trim()) {
    throw new Error('Loop agents require a verifyCmd (a machine gate — tests, build, or lint that returns pass/fail)');
  }
  if (l.goal.length > 2000) throw new Error('Loop goal must be under 2,000 characters');
  if (l.verifyCmd.length > 1000) throw new Error('Loop verifyCmd must be under 1,000 characters');
  const mode: LoopMode = l.mode === 'goal-driven' ? 'goal-driven' : 'scheduled';
  const permissionProfile: PermissionProfile =
    l.permissionProfile === 'readonly' || l.permissionProfile === 'full' ? l.permissionProfile : 'safe-write';
  return {
    goal: l.goal.trim(),
    verifyCmd: l.verifyCmd.trim(),
    iterCap: clampInt(l.iterCap, 1, 1000, LOOP_DEFAULT_ITER_CAP),
    costCapUsd: clampNum(l.costCapUsd, 0.5, 100, LOOP_DEFAULT_COST_CAP_USD),
    mode,
    permissionProfile,
    skill: (typeof l.skill === 'string' && l.skill.trim()) ? l.skill.trim() : 'scheduled-loop',
  };
}

const AGENTS_DIR = resolve(process.env.WORKSPACE || '/workspace', '.codeck/agents');
const MANIFEST_PATH = join(AGENTS_DIR, 'manifest.json');

/**
 * Remap a cwd stored with the host workspace path to the container path.
 * Agent configs are created with the host path (e.g. /home/codeck/workspace/project)
 * but inside the container the workspace is bind-mounted at /workspace.
 * CODECK_HOST_WORKSPACE lets the runtime know the host prefix to strip.
 */
function resolveAgentCwd(cwd: string): string {
  const containerWorkspace = process.env.WORKSPACE || '/workspace';
  const hostWorkspace = process.env.CODECK_HOST_WORKSPACE;
  if (hostWorkspace && cwd.startsWith(hostWorkspace)) {
    return containerWorkspace + cwd.slice(hostWorkspace.length);
  }
  return cwd;
}

let _broadcastFn: BroadcastFn = () => {};

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

// Per-loop isolated control-plane dirs. Passed to the headless run via
// CODECK_HARNESS_DIR / CODECK_STATE_DIR so budget-guard, no-progress-guard,
// workflow-checkpoint and harness-resume read/write here instead of the global
// /workspace/.codeck/harness — no collision with an interactive harness task.
function harnessDir(id: string): string {
  return join(agentDir(id), 'harness');
}

function loopStateDir(id: string): string {
  return join(agentDir(id), 'state');
}

function inboxDir(id: string): string {
  return join(agentDir(id), 'inbox');
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
    kind: runtime.config.kind === 'loop' ? 'loop' : 'oneshot',
    loop: runtime.config.loop,
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

const SUSPICIOUS_PATTERNS: Array<{ pattern: RegExp; description: string; severity: 'high' | 'medium' }> = [
  { pattern: /docker\s+run.*--privileged/i, description: 'Privileged container spawn (grants host root access)', severity: 'high' },
  { pattern: /nsenter.*-t\s*1/i, description: 'Host namespace entry (container escape technique)', severity: 'high' },
  { pattern: /chroot\s+\/host/i, description: 'Host filesystem chroot (container escape)', severity: 'high' },
  { pattern: /docker\s+run.*-v\s+\/:/i, description: 'Host root filesystem mount', severity: 'high' },
  { pattern: /docker\s+run.*--pid[= ]host/i, description: 'Host PID namespace (container escape)', severity: 'high' },
  { pattern: /docker\s+run.*--network[= ]host/i, description: 'Host network namespace access', severity: 'medium' },
  { pattern: /docker\s+exec/i, description: 'Exec into container (lateral movement)', severity: 'medium' },
];

export function lintAgentObjective(objective: string): Array<{ description: string; severity: 'high' | 'medium' }> {
  const warnings: Array<{ description: string; severity: 'high' | 'medium' }> = [];
  for (const { pattern, description, severity } of SUSPICIOUS_PATTERNS) {
    if (pattern.test(objective)) {
      warnings.push({ description, severity });
    }
  }
  return warnings;
}

// ── Validation ──

/**
 * Validates that a cwd path is safe and within the workspace.
 * Prevents path traversal and execution outside workspace boundaries.
 */
function validateAgentCwd(cwd: string): void {
  if (!cwd || typeof cwd !== 'string') throw new Error('Working directory is required');
  if (!isAbsolute(cwd)) throw new Error('Working directory must be an absolute path');
  if (cwd.includes('\0')) throw new Error('Working directory must not contain null bytes');
  if (cwd.length > 500) throw new Error('Working directory path too long (max 500 chars)');

  const normalized = resolve(cwd);
  const workspace = process.env.WORKSPACE || '/workspace';
  const allowedBases = [workspace, '/home/codeck/workspace'];

  const allowed = allowedBases.some(base => normalized === base || normalized.startsWith(base + '/'));
  if (!allowed) {
    throw new Error(`Working directory must be within workspace (${workspace}). Got: ${normalized}`);
  }
}

// ── Scheduler deps factory ──

function getSchedulerDeps(): SchedulerDeps {
  return {
    agents,
    cwdLocks,
    cwdQueues,
    broadcastFn: () => _broadcastFn,
    resolveAgentCwd,
    executionsDir,
    harnessDir,
    loopStateDir,
    inboxDir,
    saveState,
    toSummary,
    pruneExecutions,
  };
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
  _broadcastFn = broadcast;
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

  const deps = getSchedulerDeps();

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
        _broadcastFn({ type: 'agent:misfire', data: { agentId: id, name: config.name, missedByMinutes: missedMinutes } });
      }
      scheduleCron(runtime, deps);
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
  validateAgentCwd(cwd);
  if (!existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Working directory must be a directory, not a file: ${cwd}`);
  }

  // Lint objective for suspicious Docker/escape patterns — block high severity
  const lintWarnings = lintAgentObjective(input.objective);
  const highSeverity = lintWarnings.filter(w => w.severity === 'high');
  if (highSeverity.length > 0) {
    throw new Error(`Objective contains dangerous patterns: ${highSeverity.map(w => w.description).join('; ')}`);
  }
  if (lintWarnings.length > 0) {
    console.warn(`[ProactiveAgents] Agent objective contains suspicious patterns: ${JSON.stringify(lintWarnings)}`);
  }

  const id = randomUUID().slice(0, 8);
  const now = Date.now();

  // Loop agents: validate the machine gate, apply loop-scale timeout defaults.
  const kind: AgentKind = input.kind === 'loop' ? 'loop' : 'oneshot';
  const loop = kind === 'loop' ? buildLoopConfig(input.loop) : undefined;
  const defaultTimeout = kind === 'loop' ? LOOP_DEFAULT_TIMEOUT_MS : 300000;
  const maxTimeout = kind === 'loop' ? LOOP_MAX_TIMEOUT_MS : Infinity;
  const timeoutMs = Math.min(input.timeoutMs || defaultTimeout, maxTimeout);

  const config: AgentConfig = {
    id,
    name: input.name,
    objective: input.objective,
    schedule: input.schedule,
    cwd,
    model: input.model || '',
    timeoutMs,
    maxRetries: input.maxRetries || 3,
    createdAt: now,
    updatedAt: now,
    kind,
    loop,
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
  if (kind === 'loop') {
    mkdirSync(inboxDir(id), { recursive: true, mode: 0o700 });
  }
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
  scheduleCron(runtime, getSchedulerDeps());

  console.log(`[ProactiveAgents] Created agent: ${config.name} (${id}, schedule=${config.schedule})`);
  _broadcastFn({ type: 'agent:update', data: toSummary(runtime) });

  return toDetail(runtime);
}

export function getAgent(id: string): AgentDetail | null {
  const runtime = agents.get(id);
  return runtime ? toDetail(runtime) : null;
}

export function listAgents(): AgentSummary[] {
  return Array.from(agents.values()).map(toSummary);
}

export function updateAgent(id: string, updates: Partial<Pick<AgentConfig, 'name' | 'objective' | 'schedule' | 'cwd' | 'model' | 'timeoutMs' | 'maxRetries'>> & { loop?: Partial<LoopConfig> }): AgentDetail | null {
  const runtime = agents.get(id);
  if (!runtime) return null;

  // Loop config can only be edited on a loop agent (kind is immutable — recreate
  // to convert). Re-validate the gate so an update can't strip goal/verifyCmd.
  let nextLoop: LoopConfig | undefined;
  if (updates.loop !== undefined) {
    if (runtime.config.kind !== 'loop') {
      throw new Error('Cannot set loop config on a one-shot agent — recreate it as a loop');
    }
    nextLoop = buildLoopConfig({ ...runtime.config.loop, ...updates.loop });
  }
  if (updates.timeoutMs !== undefined && runtime.config.kind === 'loop') {
    updates.timeoutMs = Math.min(updates.timeoutMs, LOOP_MAX_TIMEOUT_MS);
  }

  if (updates.name && updates.name.length > 50) {
    throw new Error('Agent name must not exceed 50 characters');
  }

  if (updates.objective && updates.objective.length > 10000) {
    throw new Error('Objective must be under 10,000 characters');
  }

  if (updates.schedule && !cron.validate(updates.schedule)) {
    throw new Error(`Invalid cron expression: ${updates.schedule}`);
  }

  if (updates.cwd) {
    validateAgentCwd(updates.cwd);
    if (!existsSync(updates.cwd)) {
      throw new Error(`Working directory does not exist: ${updates.cwd}`);
    }
  }

  // Lint updated objective — block high severity patterns
  if (updates.objective) {
    const lintWarnings = lintAgentObjective(updates.objective);
    const highSeverity = lintWarnings.filter(w => w.severity === 'high');
    if (highSeverity.length > 0) {
      throw new Error(`Objective contains dangerous patterns: ${highSeverity.map(w => w.description).join('; ')}`);
    }
    if (lintWarnings.length > 0) {
      console.warn(`[ProactiveAgents] Updated objective for agent ${id} contains suspicious patterns: ${JSON.stringify(lintWarnings)}`);
    }
  }

  const scheduleChanged = updates.schedule && updates.schedule !== runtime.config.schedule;

  const { loop: _loopRaw, ...configUpdates } = updates;
  Object.assign(runtime.config, configUpdates, { updatedAt: Date.now() });
  if (nextLoop) runtime.config.loop = nextLoop;
  saveConfig(runtime.config);

  if (scheduleChanged && runtime.state.status === 'active') {
    scheduleCron(runtime, getSchedulerDeps());
  }

  _broadcastFn({ type: 'agent:update', data: toSummary(runtime) });
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

  _broadcastFn({ type: 'agent:update', data: toSummary(runtime) });
  console.log(`[ProactiveAgents] Paused agent: ${runtime.config.name} (${id})`);
  return toDetail(runtime);
}

export function resumeAgent(id: string): AgentDetail | null {
  const runtime = agents.get(id);
  if (!runtime) return null;

  runtime.state.status = 'active';
  runtime.state.consecutiveFailures = 0;
  scheduleCron(runtime, getSchedulerDeps());
  saveState(id, runtime.state);

  _broadcastFn({ type: 'agent:update', data: toSummary(runtime) });
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

  enqueueExecution(id, getSchedulerDeps());

  // Restore status if it was not active and we didn't actually start
  if (wasStatus !== 'active' && !runtime.currentExecution) {
    runtime.state.status = wasStatus;
  }

  return { executionId: 'queued' };
}

// ── Queries (delegate to logs sub-module) ──

export function getAgentOutput(id: string): string | null {
  return _getAgentOutput(agents, id);
}

export function getAgentLogs(id: string, timestamp?: string): string | null {
  return _getAgentLogs(agents, executionsDir, id, timestamp);
}

export function getAgentExecutions(id: string, limit = 20): ExecutionResult[] {
  return _getAgentExecutions(executionsDir, id, limit);
}

// ── Loop queries ──

/**
 * Aggregate the article's north-star metric for a loop: cost per accepted change.
 * A tick is "accepted" when the PO set overseer.done and every criterion is
 * done+evidence; "escalated" when the PO handed it to a human.
 */
export function getLoopAcceptance(id: string): LoopAcceptance | null {
  const runtime = agents.get(id);
  if (!runtime || runtime.config.kind !== 'loop') return null;

  const execs = _getAgentExecutions(executionsDir, id, MAX_EXECUTION_HISTORY);
  let accepted = 0, escalated = 0, failed = 0, totalCostUsd = 0;
  for (const e of execs) {
    if (e.result !== 'success') failed++;
    if (e.accepted) accepted++;
    if (e.escalated) escalated++;
    if (typeof e.costUsd === 'number' && Number.isFinite(e.costUsd)) totalCostUsd += e.costUsd;
  }
  const totalTicks = execs.length;
  const round4 = (n: number) => Math.round(n * 10000) / 10000;
  return {
    totalTicks,
    accepted,
    escalated,
    failed,
    acceptanceRate: totalTicks > 0 ? round4(accepted / totalTicks) : 0,
    totalCostUsd: round4(totalCostUsd),
    costPerAcceptedUsd: accepted > 0 ? round4(totalCostUsd / accepted) : null,
  };
}

/** List inbox entries (escalations needing human judgment), newest first. */
export function getLoopInbox(id: string): InboxEntry[] | null {
  const runtime = agents.get(id);
  if (!runtime || runtime.config.kind !== 'loop') return null;

  const dir = inboxDir(id);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, MAX_INBOX_ENTRIES);
  } catch { return []; }

  const entries: InboxEntry[] = [];
  for (const f of files) {
    try {
      const full = join(dir, f);
      const st = statSync(full);
      const content = readFileSync(full, 'utf8');
      entries.push({ file: f, createdAt: st.mtimeMs, preview: content.slice(0, 500) });
    } catch { /* skip unreadable */ }
  }
  return entries;
}

/** Read one inbox entry in full. Filename is validated to block path traversal. */
export function getLoopInboxEntry(id: string, file: string): string | null {
  const runtime = agents.get(id);
  if (!runtime || runtime.config.kind !== 'loop') return null;
  if (!/^[\w.\-]+\.md$/.test(file) || file.includes('..')) return null;
  const full = join(inboxDir(id), file);
  if (!existsSync(full)) return null;
  try { return readFileSync(full, 'utf8'); } catch { return null; }
}
