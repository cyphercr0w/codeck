#!/usr/bin/env node

/**
 * PostCompact Hook — Re-inject Codeck memory after context compaction.
 *
 * Reads pre-compact state + durable memory + daily log and injects them
 * as context so the agent knows what was happening before compaction.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

function computePathId(absPath) {
  return createHash('sha256').update(absPath).digest('hex').slice(0, 12);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const sections = [];

// 1. Pre-compact state (MOST IMPORTANT — what we were doing)
const preCompactPath = '/workspace/.codeck/state/pre-compact-state.json';
if (existsSync(preCompactPath)) {
  try {
    const state = JSON.parse(readFileSync(preCompactPath, 'utf-8'));
    const parts = [];
    parts.push(`Compacted at: ${state.timestamp}`);
    parts.push(`Working in: ${state.cwd} (${state.projectName})`);
    if (state.modifiedFiles?.length) parts.push(`Modified files: ${state.modifiedFiles.join(', ')}`);
    if (state.activeAgents?.length) parts.push(`Active agents: ${state.activeAgents.map(a => a.name).join(', ')}`);
    if (state.recentDecisions?.length) {
      parts.push('Recent decisions:');
      for (const d of state.recentDecisions) {
        parts.push(`  - ${d.file}: ${d.excerpt.split('\n')[0]}`);
      }
    }
    sections.push(`<pre-compact-state>\n${parts.join('\n')}\n</pre-compact-state>`);

    // Inject full daily log from pre-compact state (captured before compaction)
    if (state.dailyLog) {
      sections.push(`<today-activity-full>\n${state.dailyLog}\n</today-activity-full>`);
    }
  } catch { /* non-fatal */ }
}

// 2. Durable memory
const memoryPath = '/workspace/.codeck/memory/MEMORY.md';
if (existsSync(memoryPath)) {
  const memory = readFileSync(memoryPath, 'utf-8').slice(0, 3000);
  sections.push(`<durable-memory>\n${memory}\n</durable-memory>`);
}

// 3. Today's daily log (in case pre-compact didn't capture it)
const today = new Date().toISOString().slice(0, 10);
const dailyPath = join('/workspace/.codeck/memory/daily', `${today}.md`);
if (existsSync(dailyPath)) {
  const daily = readFileSync(dailyPath, 'utf-8');
  // Only add if not already injected from pre-compact state
  if (!sections.some(s => s.includes('<today-activity-full>'))) {
    sections.push(`<today-activity date="${today}">\n${daily}\n</today-activity>`);
  }
}

// 4. User preferences
const prefsPath = '/workspace/.codeck/preferences.md';
if (existsSync(prefsPath)) {
  const prefs = readFileSync(prefsPath, 'utf-8').slice(0, 1500);
  sections.push(`<user-preferences>\n${prefs}\n</user-preferences>`);
}

// 5. Path-scoped memory for cwd
const cwd = parsed.cwd || process.env.WORKSPACE || '/workspace';
const projectName = cwd.split('/').pop();
if (cwd && cwd !== '/workspace') {
  const pathId = computePathId(cwd);
  const pathMemory = join('/workspace/.codeck/memory/paths', pathId, 'MEMORY.md');
  if (existsSync(pathMemory)) {
    const content = readFileSync(pathMemory, 'utf-8');
    sections.push(`<project-memory project="${projectName}">\n${content.slice(0, 2000)}\n</project-memory>`);
  }
}

if (sections.length === 0) process.exit(0);

const reminder = [
  '<context-restored>',
  ...sections,
  '</context-restored>',
  '',
  'CONTEXT RESTORED after compaction. Read the above carefully — it contains:',
  '- What you were working on before compaction (pre-compact state + daily log)',
  '- Durable memory and user preferences',
  '- Project-specific memory if applicable',
  '',
  'If critical information is missing, check:',
  '- Daily logs: /workspace/.codeck/memory/daily/',
  '- Durable memory: /workspace/.codeck/memory/MEMORY.md',
  '- Research: look for RESEARCH-*.md files in the workspace',
].join('\n');

console.log(JSON.stringify({
  systemMessage: reminder,
}));
