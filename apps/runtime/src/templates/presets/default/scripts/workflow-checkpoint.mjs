#!/usr/bin/env node
/**
 * Stop Hook — Workflow Checkpoint
 *
 * When Claude wants to stop after making code changes, this hook checks:
 * 1. Were files edited/written? (tracked by PostToolUse via edit-tracker state)
 * 2. Was a code-reviewer sub-agent spawned since those edits?
 * 3. Was the build verified?
 *
 * If significant edits happened without review → BLOCKS the stop and tells
 * Claude to run code-reviewer before presenting results.
 *
 * This makes the implement→review→present flow mechanical, not aspirational.
 *
 * Output format (Claude Code Stop hook contract):
 *   { "result": "approve" }                    — let Claude stop
 *   { "result": "block", "reason": "...", "message": "..." } — force continue
 */

// Teammates (sub-agents) skip this hook — only the lead needs it
if (process.env.CLAUDE_CODE_TEAM_NAME) process.exit(0);

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const STATE_DIR = '/workspace/.codeck/state';
const EDIT_TRACKER = join(STATE_DIR, 'edit-tracker.json');
const REVIEW_MARKER = join(STATE_DIR, 'review-marker.json');

// Read stdin (Stop hook payload)
let input = '';
for await (const chunk of process.stdin) input += chunk;

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

// Read edit tracker state
let edits = { files: [], count: 0, since: 0 };
try {
  if (existsSync(EDIT_TRACKER)) {
    edits = JSON.parse(readFileSync(EDIT_TRACKER, 'utf-8'));
  }
} catch { /* start fresh */ }

// No edits tracked → approve stop (nothing to review)
if (!edits.count || edits.count === 0) {
  console.log(JSON.stringify({ result: 'approve' }));
  process.exit(0);
}

// Small changes (1-4 files) → approve without review
// Review is for meaningful implementation work (5+ files), not every small fix
if (edits.count <= 4) {
  // Clear tracker so next stop doesn't re-check these
  writeFileSync(EDIT_TRACKER, JSON.stringify({ files: [], count: 0, since: 0 }));
  console.log(JSON.stringify({ result: 'approve' }));
  process.exit(0);
}

// If sub-agents are actively working, don't block — review comes after they finish
try {
  const subagentFile = join(STATE_DIR, 'active-subagents.json');
  if (existsSync(subagentFile)) {
    const subs = JSON.parse(readFileSync(subagentFile, 'utf-8'));
    if (subs.count > 0 && (Date.now() - subs.lastUpdate) < 600000) {
      // Sub-agents active within last 10 minutes — approve silently
      console.log(JSON.stringify({ result: 'approve' }));
      process.exit(0);
    }
  }
} catch { /* no subagent tracking */ }

// Significant edits (5+ files) — check if review happened
let reviewRecent = false;
try {
  if (existsSync(REVIEW_MARKER)) {
    const marker = JSON.parse(readFileSync(REVIEW_MARKER, 'utf-8'));
    // Review must be AFTER the edits started
    if (marker.timestamp && marker.timestamp > edits.since) {
      reviewRecent = true;
    }
  }
} catch { /* no valid marker */ }

if (reviewRecent) {
  // Review was done — approve and clear tracker
  writeFileSync(EDIT_TRACKER, JSON.stringify({ files: [], count: 0, since: 0 }));
  console.log(JSON.stringify({ result: 'approve' }));
  process.exit(0);
}

// Significant edits WITHOUT review → block
const fileList = edits.files.slice(0, 8).join(', ');
const msg = edits.count > 8
  ? `${fileList}, and ${edits.count - 8} more`
  : fileList;

console.log(JSON.stringify({
  result: 'block',
  reason: `You modified ${edits.count} files (${msg}) but haven't run code-reviewer yet.`,
  message: `Stop hook feedback:\nYou modified ${edits.count} files (${msg}) but haven't run code-reviewer yet.\nSpawn a code-reviewer sub-agent before presenting results. After review, write marker: echo '{"timestamp":'$(date +%s%3N)',"agent":"code-reviewer"}' > /workspace/.codeck/state/review-marker.json`,
}));
