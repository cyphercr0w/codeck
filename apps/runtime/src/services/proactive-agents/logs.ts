import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { AgentRuntime, ExecutionResult } from './types.js';

// ── Log management ──

export function getAgentOutput(agents: Map<string, AgentRuntime>, id: string): string | null {
  const runtime = agents.get(id);
  if (!runtime) return null;
  return runtime.outputBuffer || null;
}

export function getAgentLogs(agents: Map<string, AgentRuntime>, executionsDir: (id: string) => string, id: string, timestamp?: string): string | null {
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

export function getAgentExecutions(executionsDir: (id: string) => string, id: string, limit = 20): ExecutionResult[] {
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
