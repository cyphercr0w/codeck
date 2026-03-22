import cron from 'node-cron';
import type { AgentRuntime, AgentState, BroadcastFn } from './types.js';
import { executeAgent, type ExecutorDeps } from './executor.js';

// ── Cron helpers ──

/**
 * Compute the next cron run time from a cron expression.
 * Parses the cron fields and finds the next matching minute.
 */
export function computeNextRun(schedule: string): number | null {
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

// ── Scheduling ──

export interface SchedulerDeps {
  agents: Map<string, AgentRuntime>;
  cwdLocks: Map<string, string>;
  cwdQueues: Map<string, string[]>;
  broadcastFn: () => BroadcastFn;
  resolveAgentCwd: (cwd: string) => string;
  executionsDir: (id: string) => string;
  saveState: (id: string, state: AgentState) => void;
  toSummary: (runtime: AgentRuntime) => object;
  pruneExecutions: (execDir: string) => void;
}

function getExecutorDeps(deps: SchedulerDeps): ExecutorDeps {
  return {
    agents: deps.agents,
    cwdLocks: deps.cwdLocks,
    broadcastFn: deps.broadcastFn,
    resolveAgentCwd: deps.resolveAgentCwd,
    executionsDir: deps.executionsDir,
    saveState: deps.saveState,
    stopCron: (runtime: AgentRuntime) => stopCron(runtime),
    toSummary: deps.toSummary,
    pruneExecutions: deps.pruneExecutions,
    processCwdQueue: (cwd: string) => processCwdQueue(cwd, deps),
  };
}

export function enqueueExecution(agentId: string, deps: SchedulerDeps): void {
  const runtime = deps.agents.get(agentId);
  if (!runtime) return;
  if (runtime.state.status !== 'active') return;
  if (runtime.currentExecution) {
    console.log(`[ProactiveAgents] Agent ${agentId} already running, skipping`);
    return;
  }

  // Use resolved cwd as the lock key — must match the key used in executeAgent's close/error handlers
  const cwd = deps.resolveAgentCwd(runtime.config.cwd);

  if (deps.cwdLocks.has(cwd)) {
    const queue = deps.cwdQueues.get(cwd) || [];
    if (!queue.includes(agentId)) {
      queue.push(agentId);
      deps.cwdQueues.set(cwd, queue);
      console.log(`[ProactiveAgents] Agent ${agentId} queued for cwd ${cwd} (${queue.length} in queue)`);
    }
    return;
  }

  deps.cwdLocks.set(cwd, agentId);
  executeAgent(agentId, getExecutorDeps(deps));
}

function processCwdQueue(cwd: string, deps: SchedulerDeps): void {
  const queue = deps.cwdQueues.get(cwd);
  if (!queue || queue.length === 0) {
    deps.cwdQueues.delete(cwd);
    return;
  }

  const nextId = queue.shift()!;
  if (queue.length === 0) deps.cwdQueues.delete(cwd);

  const runtime = deps.agents.get(nextId);
  if (runtime && runtime.state.status === 'active' && !runtime.currentExecution) {
    deps.cwdLocks.set(cwd, nextId);
    executeAgent(nextId, getExecutorDeps(deps));
  } else {
    // Skip invalid entry, try next
    processCwdQueue(cwd, deps);
  }
}

export function scheduleCron(runtime: AgentRuntime, deps: SchedulerDeps): void {
  if (runtime.cronJob) {
    runtime.cronJob.stop();
    runtime.cronJob = null;
  }
  if (runtime.state.status !== 'active') return;

  runtime.cronJob = cron.schedule(runtime.config.schedule, () => {
    enqueueExecution(runtime.config.id, deps);
    // Update nextRunAt after each trigger
    runtime.state.nextRunAt = computeNextRun(runtime.config.schedule);
    deps.saveState(runtime.config.id, runtime.state);
    deps.broadcastFn()({ type: 'agent:update', data: deps.toSummary(runtime) });
  });

  runtime.state.nextRunAt = computeNextRun(runtime.config.schedule);
  deps.saveState(runtime.config.id, runtime.state);
}

export function stopCron(runtime: AgentRuntime): void {
  if (runtime.cronJob) {
    runtime.cronJob.stop();
    runtime.cronJob = null;
  }
  runtime.state.nextRunAt = null;
}
