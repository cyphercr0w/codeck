#!/usr/bin/env node

/**
 * PostCompact Hook — Re-inject Codeck memory after context compaction.
 *
 * When Claude Code compacts context (long sessions), it loses awareness of
 * Codeck's memory system, user preferences, and ongoing task state.
 * This hook reads critical context and re-injects it via additionalContext.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

/** Compute path-scoped ID — mirrors resolvePathId() in memory.ts */
function computePathId(absPath) {
  return createHash('sha256').update(absPath).digest('hex').slice(0, 12);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const sections = [];

// 1. Durable memory (excerpt)
const memoryPath = '/workspace/.codeck/memory/MEMORY.md';
if (existsSync(memoryPath)) {
  const memory = readFileSync(memoryPath, 'utf-8').slice(0, 3000);
  sections.push(`<durable-memory>\n${memory}\n</durable-memory>`);
}

// 2. Today's daily log (recent entries)
const today = new Date().toISOString().slice(0, 10);
const dailyPath = join('/workspace/.codeck/memory/daily', `${today}.md`);
if (existsSync(dailyPath)) {
  const daily = readFileSync(dailyPath, 'utf-8').slice(-2000);
  sections.push(`<today-activity date="${today}">\n${daily}\n</today-activity>`);
}

// 3. User preferences
const prefsPath = '/workspace/.codeck/preferences.md';
if (existsSync(prefsPath)) {
  const prefs = readFileSync(prefsPath, 'utf-8').slice(0, 1500);
  sections.push(`<user-preferences>\n${prefs}\n</user-preferences>`);
}

// 4. Path-scoped memory for cwd (computed via SHA256 pathId)
const cwd = parsed.cwd || process.env.WORKSPACE || '/workspace';
const projectName = cwd.split('/').pop();
if (cwd && cwd !== '/workspace') {
  const pathId = computePathId(cwd);
  const pathMemory = join('/workspace/.codeck/memory/paths', pathId, 'MEMORY.md');
  if (existsSync(pathMemory)) {
    const content = readFileSync(pathMemory, 'utf-8');
    sections.push(`<project-memory project="${projectName}">\n${content.slice(0, 2000)}\n</project-memory>`);
  }

  // Also inject path-scoped daily log
  const pathDailyPath = join('/workspace/.codeck/memory/paths', pathId, 'daily', `${today}.md`);
  if (existsSync(pathDailyPath)) {
    const pathDaily = readFileSync(pathDailyPath, 'utf-8').slice(-1500);
    sections.push(`<project-today project="${projectName}">\n${pathDaily}\n</project-today>`);
  }
}

// 5. PreCompact state (modified files, active agents)
const preCompactPath = '/workspace/.codeck/state/pre-compact-state.json';
if (existsSync(preCompactPath)) {
  try {
    const state = JSON.parse(readFileSync(preCompactPath, 'utf-8'));
    const parts = [];
    if (state.modifiedFiles?.length) parts.push(`Modified files: ${state.modifiedFiles.join(', ')}`);
    if (state.activeAgents?.length) parts.push(`Active agents: ${state.activeAgents.map(a => a.name).join(', ')}`);
    if (parts.length) sections.push(`<pre-compact-state>\n${parts.join('\n')}\n</pre-compact-state>`);
  } catch { /* non-fatal */ }
}

if (sections.length === 0) process.exit(0);

const reminder = [
  '<context-restored>',
  ...sections,
  '</context-restored>',
  '',
  'REMINDER: You are inside Codeck, a cloud sandbox with persistent memory.',
  'Memory: /workspace/.codeck/memory/ | Rules: /workspace/.codeck/rules/base/ + /workspace/.codeck/rules/user/',
  'Skills: /root/.claude/skills/ (load with /learn <name>)',
  'Write to daily log periodically. Search memory before saying "I don\'t know".',
].join('\n');

console.log(JSON.stringify({
  systemMessage: reminder,
}));
