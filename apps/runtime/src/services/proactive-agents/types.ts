import type { ChildProcess } from 'child_process';
import type cron from 'node-cron';

// ── Types ──

export type AgentStatus = 'active' | 'paused' | 'error';

// A "loop" agent runs the full PO-driven autonomous-harness on each cron tick
// (plan pre-approved from plan.md → implement → review → audit → evidence-gated
// DONE) inside an isolated harness/state dir, instead of a bare one-shot run.
export type AgentKind = 'oneshot' | 'loop';

// scheduled: the cron cadence IS the loop — each tick is one bounded, verified
//   unit of work (e.g. weekly dependency review, nightly CI triage).
// goal-driven: self-continues via the harness Stop keep-alive until the machine
//   gate passes or budget cap, then auto-pauses.
export type LoopMode = 'scheduled' | 'goal-driven';

// Least-privilege posture for unattended runs. The article's blacklist
// (deploy/publish/push/dependency-upgrade) is denied unless 'full'; the loop
// ESCALATEs to its inbox instead of taking irreversible actions.
export type PermissionProfile = 'readonly' | 'safe-write' | 'full';

export interface LoopConfig {
  goal: string;          // OBSERVABLE stop condition ("all tests in test/auth pass")
  verifyCmd: string;     // the MACHINE gate — tests/build/lint. Required for loops.
  iterCap: number;       // → budget.json iterCap (hard iteration ceiling)
  costCapUsd: number;    // → budget.json costCapUsd
  mode: LoopMode;
  permissionProfile: PermissionProfile;
  skill?: string;        // triage skill to load (default: 'scheduled-loop')
}

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
  kind?: AgentKind;      // undefined ⇒ 'oneshot' (backward compatible)
  loop?: LoopConfig;     // present iff kind === 'loop'
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
  // Loop runs only — harness outcome read back from the isolated state after the
  // tick, powering the "cost per accepted change" acceptance metric.
  kind?: AgentKind;
  accepted?: boolean;    // overseer.done && every criterion done+evidence
  escalated?: boolean;   // PO ESCALATE — needs a human, surfaced in the inbox
  costUsd?: number;      // budget.json spentUsd at end of tick
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
  kind: AgentKind;
  loop?: LoopConfig;
}

export interface AgentDetail extends AgentSummary {
  consecutiveFailures: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRuntime {
  config: AgentConfig;
  state: AgentState;
  cronJob: ReturnType<typeof cron.schedule> | null;
  currentExecution: ChildProcess | null;
  outputBuffer: string;
}

export type BroadcastFn = (msg: object) => void;

export interface ObjectiveLintWarning {
  description: string;
  severity: 'high' | 'medium';
}

export interface CreateAgentInput {
  name: string;
  objective: string;
  schedule: string;
  cwd?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  kind?: AgentKind;
  loop?: Partial<LoopConfig>;
}

// Aggregate acceptance metrics for a loop agent — the article's north-star:
// measure by cost per accepted change, not by run/token count.
export interface LoopAcceptance {
  totalTicks: number;
  accepted: number;
  escalated: number;
  failed: number;
  acceptanceRate: number;       // accepted / totalTicks (0 if none)
  totalCostUsd: number;
  costPerAcceptedUsd: number | null;  // null until at least one accepted tick
}

export interface InboxEntry {
  file: string;
  createdAt: number;
  preview: string;
}
