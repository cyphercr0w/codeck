#!/usr/bin/env node

/**
 * PreToolUse Hook — Decision-time guidance via heuristic analysis.
 *
 * Analyzes recent agent behavior and injects contextual micro-instructions
 * before tool execution. Based on Replit's pattern but using deterministic
 * heuristics instead of an LLM classifier.
 *
 * Detects:
 * 1. Doom loops: repeated failures on the same file/command
 * 2. Error nudging: recent verify failures that need addressing
 * 3. Retry exhaustion: too many sequential attempts without progress
 */

// Teammates (sub-agents) skip this hook — only the lead needs it
if (process.env.CLAUDE_CODE_TEAM_NAME) process.exit(0);

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const STATE_DIR = '/workspace/.codeck/state';
const OBS_PATH = join(STATE_DIR, 'learning-observations.jsonl');
const GUIDANCE_STATE_PATH = join(STATE_DIR, 'guidance-state.json');

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const toolName = parsed.tool_name || '';
const toolInput = parsed.tool_input || {};

// Load guidance state (tracks recent patterns)
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
let state = { recentErrors: [], lastFile: '', consecutiveFailsOnFile: 0, lastGuidanceAt: 0 };
try {
  if (existsSync(GUIDANCE_STATE_PATH)) {
    state = JSON.parse(readFileSync(GUIDANCE_STATE_PATH, 'utf-8'));
  }
} catch { /* start fresh */ }

const now = Date.now();
const nudges = [];

// ── Doom loop detection ────────────────────────────────────────
// If the agent keeps editing the same file and errors keep occurring
const currentFile = toolInput.file_path || toolInput.command || '';
if (currentFile && currentFile === state.lastFile) {
  state.consecutiveFailsOnFile = (state.consecutiveFailsOnFile || 0);
  // Check if recent observations show errors on this file
  if (existsSync(OBS_PATH)) {
    try {
      const lines = readFileSync(OBS_PATH, 'utf-8').trim().split('\n').slice(-5);
      const recentErrors = lines.filter(l => {
        try {
          const obs = JSON.parse(l);
          return obs.file && currentFile.includes(obs.file.split('/').pop());
        } catch { return false; }
      });
      if (recentErrors.length >= 3) {
        state.consecutiveFailsOnFile++;
      }
    } catch { /* non-fatal */ }
  }
} else {
  state.lastFile = currentFile;
  state.consecutiveFailsOnFile = 0;
}

// Doom loop: 3+ consecutive fails on the same file
if (state.consecutiveFailsOnFile >= 3) {
  nudges.push('STOP — you are in a doom loop. You have failed 3+ times on the same file. Step back: re-read the error carefully, try a fundamentally different approach, or spawn a planner sub-agent for a fresh perspective.');
  state.consecutiveFailsOnFile = 0; // Reset after warning
}

// ── Error nudging ──────────────────────────────────────────────
// If the last tool result had errors, remind before next action
if (toolName === 'Edit' || toolName === 'Write') {
  if (existsSync(OBS_PATH)) {
    try {
      const lines = readFileSync(OBS_PATH, 'utf-8').trim().split('\n').slice(-3);
      const lastObs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const recentError = lastObs.find(o => o.tool === 'Edit' || o.tool === 'Write');
      if (recentError && (now - new Date(recentError.timestamp).getTime()) < 120000) {
        nudges.push(`Note: a recent edit caused an error (${recentError.error.slice(0, 100)}). Make sure your current edit addresses this.`);
      }
    } catch { /* non-fatal */ }
  }
}

// ── Retry exhaustion ───────────────────────────────────────────
// Count recent observations — if >10 errors in last 5 minutes, something is wrong
if (existsSync(OBS_PATH)) {
  try {
    const lines = readFileSync(OBS_PATH, 'utf-8').trim().split('\n').slice(-20);
    const fiveMinAgo = now - 300000;
    const recentCount = lines.filter(l => {
      try {
        const obs = JSON.parse(l);
        return new Date(obs.timestamp).getTime() > fiveMinAgo;
      } catch { return false; }
    }).length;
    if (recentCount >= 10) {
      nudges.push('Warning: 10+ errors in the last 5 minutes. Consider running /compact and starting fresh, or spawning a sub-agent to investigate.');
    }
  } catch { /* non-fatal */ }
}

// Save state
state.lastGuidanceAt = now;
try {
  writeFileSync(GUIDANCE_STATE_PATH, JSON.stringify(state));
} catch { /* non-fatal */ }

// Only inject guidance if we have something to say, and not too frequently (min 30s gap)
if (nudges.length === 0 || (now - (state.lastGuidanceAt || 0)) < 30000) {
  process.exit(0);
}

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: nudges.some(n => n.startsWith('STOP')) ? 'deny' : 'allow',
    permissionDecisionReason: nudges.join('\n'),
  }
}));
