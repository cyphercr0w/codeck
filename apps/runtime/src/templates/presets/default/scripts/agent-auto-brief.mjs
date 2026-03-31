#!/usr/bin/env node

/**
 * PreToolUse Hook (Agent) — Auto-inject project context into sub-agent prompts.
 *
 * Enriches Agent tool prompts with: project name/summary, current branch,
 * recent commits, and user preferences. Never blocks — always exit 0.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

if (parsed.tool_name !== 'Agent') process.exit(0);

const prompt = parsed.tool_input?.prompt;
if (!prompt) process.exit(0);

try {
  const contextLines = ['[Auto-injected project context]'];

  // Project name + summary from path-memory
  try {
    const pathMemory = JSON.parse(fs.readFileSync('/workspace/.codeck/memory/path-memory.json', 'utf8'));
    const cwd = process.cwd();
    const entry = pathMemory[cwd] || Object.values(pathMemory)[0];
    if (entry) {
      const name = entry.name || path.basename(cwd);
      const summary = (entry.summary || '').slice(0, 500);
      contextLines.push(`Project: ${name}`);
      if (summary) contextLines.push(`Summary: ${summary}`);
    } else {
      contextLines.push(`Project: ${process.cwd().split('/').pop()}`);
    }
  } catch {
    contextLines.push(`Project: ${process.cwd().split('/').pop()}`);
  }

  // Git branch + recent commits
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
    contextLines.push(`Branch: ${branch}`);
  } catch { /* skip if not a git repo */ }

  try {
    const log = execFileSync('git', ['log', '--oneline', '-3'], { encoding: 'utf8' }).trim();
    if (log) contextLines.push(`Recent commits:\n${log}`);
  } catch { /* skip */ }

  // User preferences — first 10 lines
  try {
    const prefs = fs.readFileSync('/workspace/.codeck/preferences.md', 'utf8');
    const first10 = prefs.split('\n').slice(0, 10).join('\n').trim();
    if (first10) contextLines.push(`User preferences:\n${first10}`);
  } catch { /* skip */ }

  const contextBlock = contextLines.join('\n');
  const updatedInput = { ...parsed.tool_input, prompt: prompt + '\n\n' + contextBlock };

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput,
    },
  }));
} catch {
  // Never block on error
}

process.exit(0);
