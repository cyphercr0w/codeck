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

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const sections = [];

// 1. Durable memory (excerpt)
const memoryPath = '/workspace/.codeck/memory/MEMORY.md';
if (existsSync(memoryPath)) {
  const memory = readFileSync(memoryPath, 'utf-8').slice(0, 3000);
  sections.push('## Durable Memory\n' + memory);
}

// 2. Today's daily log (recent entries)
const today = new Date().toISOString().slice(0, 10);
const dailyPath = join('/workspace/.codeck/memory/daily', `${today}.md`);
if (existsSync(dailyPath)) {
  const daily = readFileSync(dailyPath, 'utf-8').slice(-2000);
  sections.push("## Today's Activity (recent)\n" + daily);
}

// 3. User preferences
const prefsPath = '/workspace/.codeck/preferences.md';
if (existsSync(prefsPath)) {
  const prefs = readFileSync(prefsPath, 'utf-8').slice(0, 1500);
  sections.push('## User Preferences\n' + prefs);
}

// 4. Path-scoped memory for cwd (if available)
const cwd = parsed.cwd || process.env.WORKSPACE || '/workspace';
const projectName = cwd.split('/').pop();
if (projectName && projectName !== 'workspace') {
  // Try to find path memory by scanning paths directory
  const pathsDir = '/workspace/.codeck/memory/paths';
  if (existsSync(pathsDir)) {
    const { readdirSync } = await import('fs');
    for (const pathId of readdirSync(pathsDir)) {
      const pathMemory = join(pathsDir, pathId, 'MEMORY.md');
      if (existsSync(pathMemory)) {
        const content = readFileSync(pathMemory, 'utf-8');
        if (content.toLowerCase().includes(projectName.toLowerCase())) {
          sections.push(`## Project Memory (${projectName})\n` + content.slice(0, 2000));
          break;
        }
      }
    }
  }
}

if (sections.length === 0) process.exit(0);

const reminder = [
  '--- CONTEXT RESTORED AFTER COMPACTION ---',
  '',
  ...sections,
  '',
  'REMINDER: You are inside Codeck, a cloud sandbox with persistent memory.',
  'Memory: /workspace/.codeck/memory/ | Rules: /workspace/.codeck/rules/',
  'Skills: /root/.claude/skills/ (load with /learn <name>)',
  'Write to daily log periodically. Search memory before saying "I don\'t know".',
].join('\n');

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostCompact',
    additionalContext: reminder,
  }
}));
