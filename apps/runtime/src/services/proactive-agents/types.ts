import type { ChildProcess } from 'child_process';
import type cron from 'node-cron';

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
}
