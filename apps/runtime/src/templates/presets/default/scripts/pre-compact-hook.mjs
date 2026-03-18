#!/usr/bin/env node

/**
 * PreCompact Hook — Save critical state before context compaction.
 *
 * Writes a marker file with current task state, modified files,
 * and active agents. The PostCompact hook reads this to re-inject context.
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

try {
  writeFileSync(markerPath, JSON.stringify(state, null, 2));
} catch { /* non-fatal */ }

// PreCompact hooks don't output anything — they just save state
process.exit(0);
