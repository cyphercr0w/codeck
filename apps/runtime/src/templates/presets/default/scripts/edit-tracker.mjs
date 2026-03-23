#!/usr/bin/env node
/**
 * PostToolUse Hook (Edit|Write) — Tracks file modifications.
 *
 * Maintains a counter of files edited/written during the current work cycle.
 * The workflow-checkpoint Stop hook reads this to decide if review is needed.
 * Counter resets when a code review completes (review-marker written).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';

const STATE_DIR = '/workspace/.codeck/state';
const EDIT_TRACKER = join(STATE_DIR, 'edit-tracker.json');

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const toolName = parsed.tool_name || '';
if (toolName !== 'Edit' && toolName !== 'Write') process.exit(0);

const filePath = parsed.tool_input?.file_path || '';
if (!filePath) process.exit(0);

// Skip non-code files (docs, config, memory, state)
const name = basename(filePath).toLowerCase();
const skipPatterns = ['.md', '.json', '.yml', '.yaml', '.txt', '.env', '.gitignore'];
if (skipPatterns.some(p => name.endsWith(p))) process.exit(0);
if (filePath.includes('.codeck/') || filePath.includes('.claude/')) process.exit(0);

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

let state = { files: [], count: 0, since: 0 };
try {
  if (existsSync(EDIT_TRACKER)) {
    state = JSON.parse(readFileSync(EDIT_TRACKER, 'utf-8'));
  }
} catch { /* start fresh */ }

// Add file if not already tracked
const shortPath = filePath.replace('/workspace/', '');
if (!state.files.includes(shortPath)) {
  state.files.push(shortPath);
  state.count = state.files.length;
  if (!state.since) state.since = Date.now();
}

writeFileSync(EDIT_TRACKER, JSON.stringify(state));
process.exit(0);
