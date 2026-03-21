#!/usr/bin/env node

/**
 * PreCompact Hook — Save critical state before context compaction.
 *
 * Captures: modified files, active agents, today's daily log,
 * and current task context so PostCompact can re-inject it.
 */

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const cwd = parsed.cwd || process.env.WORKSPACE || '/workspace';
const stateDir = '/workspace/.codeck/state';
const markerPath = join(stateDir, 'pre-compact-state.json');

if (!existsSync(stateDir)) {
  mkdirSync(stateDir, { recursive: true });
}

const state = {
  timestamp: new Date().toISOString(),
  cwd,
  projectName: cwd.split('/').pop(),
  modifiedFiles: [],
  activeAgents: [],
  dailyLog: '',
  recentDecisions: [],
};

// Gather modified files
try {
  const diff = execSync('git diff --name-only 2>/dev/null || true', {
    cwd, timeout: 3000, encoding: 'utf-8'
  }).trim();
  if (diff) state.modifiedFiles = diff.split('\n').filter(Boolean);
} catch { /* non-fatal */ }

// Gather staged files too
try {
  const staged = execSync('git diff --cached --name-only 2>/dev/null || true', {
    cwd, timeout: 3000, encoding: 'utf-8'
  }).trim();
  if (staged) {
    const stagedFiles = staged.split('\n').filter(Boolean);
    state.modifiedFiles = [...new Set([...state.modifiedFiles, ...stagedFiles])];
  }
} catch { /* non-fatal */ }

// Gather active cron agents
try {
  const agentsDir = '/workspace/.codeck/agents';
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir)) {
      const configPath = join(agentsDir, entry, 'config.json');
      if (existsSync(configPath)) {
        try {
          const config = JSON.parse(readFileSync(configPath, 'utf-8'));
          state.activeAgents.push({ id: config.id, name: config.name, schedule: config.schedule });
        } catch { /* skip invalid */ }
      }
    }
  }
} catch { /* non-fatal */ }

// Capture today's daily log (full content — this is the most important context)
try {
  const today = new Date().toISOString().slice(0, 10);
  const dailyPath = join('/workspace/.codeck/memory/daily', `${today}.md`);
  if (existsSync(dailyPath)) {
    state.dailyLog = readFileSync(dailyPath, 'utf-8');
  }
} catch { /* non-fatal */ }

// Capture recent decisions
try {
  const decisionsDir = '/workspace/.codeck/memory/decisions';
  if (existsSync(decisionsDir)) {
    const files = readdirSync(decisionsDir).filter(f => f.endsWith('.md')).sort().slice(-3);
    for (const f of files) {
      try {
        const content = readFileSync(join(decisionsDir, f), 'utf-8').slice(0, 500);
        state.recentDecisions.push({ file: f, excerpt: content });
      } catch { /* skip */ }
    }
  }
} catch { /* non-fatal */ }

try {
  writeFileSync(markerPath, JSON.stringify(state, null, 2));
} catch { /* non-fatal */ }

// Output a reminder to the agent that compaction is happening
console.log(JSON.stringify({
  additionalContext: 'IMPORTANT: Context is about to be compacted. If you have critical findings or decisions that are only in conversation context (not yet written to daily log or memory), write them NOW before they are lost.'
}));
