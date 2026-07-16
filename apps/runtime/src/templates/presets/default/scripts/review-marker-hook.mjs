#!/usr/bin/env node

/**
 * SubagentStop Hook — Marks that a code review was completed.
 *
 * When a sub-agent named "code-reviewer" finishes, writes a timestamp
 * marker that the review-gate-hook reads before allowing git commit.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';

const STATE_DIR = '/workspace/.codeck/state';
const MARKER_PATH = `${STATE_DIR}/review-marker.json`;

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

// Check if this is a code-reviewer subagent
const agentName = parsed.agent_name || parsed.subagent_name || '';
if (!agentName.includes('code-review')) process.exit(0);

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

// A review ran, but this hook cannot know whether findings were resolved.
// `clean:false` means "unconfirmed" — in the autonomous harness the lead must
// overwrite with clean:true only after re-reviewing to ZERO findings (that is
// what forces the review loop). Legacy (non-harness) gate accepts either.
writeFileSync(MARKER_PATH, JSON.stringify({
  timestamp: Date.now(),
  agent: agentName,
  clean: false,
  findings: null,
}));

process.exit(0);
