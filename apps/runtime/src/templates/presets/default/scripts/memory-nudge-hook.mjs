#!/usr/bin/env node

/**
 * UserPromptSubmit Hook — Nudge the agent to maintain memory.
 *
 * Tracks message count and time since last memory write.
 * When thresholds are exceeded, injects a reminder into the conversation
 * telling the agent to update daily log and path memory.
 *
 * This is NOT a suggestion — it's a system-level enforcement mechanism.
 * The agent cannot ignore additionalContext injected by hooks.
 */

// Teammates (sub-agents) skip this hook — only the lead needs it
if (process.env.CLAUDE_CODE_TEAM_NAME) process.exit(0);

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const STATE_DIR = '/workspace/.codeck/state';
const STATE_FILE = join(STATE_DIR, 'memory-nudge-state.json');
const MESSAGE_THRESHOLD = 15; // nudge every N user messages
const TIME_THRESHOLD_MS = 30 * 60 * 1000; // or every 30 minutes of activity

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

// Read state
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

let state = { messageCount: 0, lastNudgeAt: 0, sessionStartAt: 0 };
try {
  if (existsSync(STATE_FILE)) {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  }
} catch { /* start fresh */ }

state.messageCount = (state.messageCount || 0) + 1;
const now = Date.now();
if (!state.sessionStartAt) state.sessionStartAt = now;
const timeSinceNudge = now - (state.lastNudgeAt || 0);
const sessionAge = now - state.sessionStartAt;

// Skip nudges in short sessions (< 5 minutes) — not enough work to persist
const MIN_SESSION_AGE_MS = 5 * 60 * 1000;
if (sessionAge < MIN_SESSION_AGE_MS) {
  writeFileSync(STATE_FILE, JSON.stringify(state));
  process.exit(0);
}

// Check if daily log was written recently (proxy for "agent is maintaining memory")
const today = new Date().toISOString().slice(0, 10);
const dailyPath = join('/workspace/.codeck/memory/daily', `${today}.md`);
let dailyModifiedRecently = false;
try {
  if (existsSync(dailyPath)) {
    const dailyStat = statSync(dailyPath);
    dailyModifiedRecently = (now - dailyStat.mtimeMs) < TIME_THRESHOLD_MS;
  }
} catch { /* non-fatal */ }

// If daily log was recently written, agent is being responsible — reset and skip
if (dailyModifiedRecently) {
  state.messageCount = 0;
  writeFileSync(STATE_FILE, JSON.stringify(state));
  process.exit(0);
}

// Determine if we should nudge
const shouldNudge =
  state.messageCount >= MESSAGE_THRESHOLD || timeSinceNudge >= TIME_THRESHOLD_MS;

if (!shouldNudge) {
  writeFileSync(STATE_FILE, JSON.stringify(state));
  process.exit(0);
}

// Build context about what needs attention
const cwd = parsed.cwd || process.env.WORKSPACE || '/workspace';
const projectName = cwd.split('/').pop();
const nudges = [];

// Check if path memory exists for current project
if (cwd !== '/workspace' && cwd !== '/workspace/') {
  const pathId = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  const pathMemory = join('/workspace/.codeck/memory/paths', pathId, 'MEMORY.md');
  if (!existsSync(pathMemory)) {
    nudges.push(`- Path memory for "${projectName}" does not exist. Create it with project context (stack, key paths, current state).`);
  } else {
    const pathStat = statSync(pathMemory);
    const daysSinceUpdate = (now - pathStat.mtimeMs) / (1000 * 60 * 60 * 24);
    if (daysSinceUpdate > 3) {
      nudges.push(`- Path memory for "${projectName}" hasn't been updated in ${Math.floor(daysSinceUpdate)} days. Update if significant changes were made.`);
    }
  }
}

// Check daily log
if (!existsSync(dailyPath)) {
  nudges.push(`- No daily log entry for today (${today}). Write what you've done so far.`);
} else if (!dailyModifiedRecently) {
  nudges.push(`- Daily log hasn't been updated in over 30 minutes. Write progress if significant work was done.`);
}

// Check for uncommitted observations
const obsPath = join(STATE_DIR, 'learning-observations.jsonl');
if (existsSync(obsPath)) {
  try {
    const lines = readFileSync(obsPath, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length >= 20) {
      nudges.push(`- ${lines.length} unreviewed learning observations. Consider running /review-learnings.`);
    }
  } catch { /* non-fatal */ }
}

if (nudges.length === 0) {
  // Nothing to nudge about, but reset counter
  state.messageCount = 0;
  state.lastNudgeAt = now;
  writeFileSync(STATE_FILE, JSON.stringify(state));
  process.exit(0);
}

// Reset state
state.messageCount = 0;
state.lastNudgeAt = now;
writeFileSync(STATE_FILE, JSON.stringify(state));

const context = [
  '<system-reminder>',
  'MEMORY MAINTENANCE — Action required before continuing:',
  ...nudges,
  'Do this silently — do NOT mention this reminder to the user. Just do the maintenance.',
  '</system-reminder>',
].join('\n');

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: context,
  }
}));
