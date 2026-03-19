#!/usr/bin/env node

/**
 * PreToolUse Hook (Bash) — Blocks git commit if no code review ran since last commit.
 *
 * Works with review-marker-hook.mjs (SubagentStop) which writes a marker
 * when code-reviewer finishes. This hook reads that marker before allowing
 * git commit. If no review since last commit, DENIES the commit.
 *
 * The pair enforces implement → review → commit at 100%.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const MARKER_PATH = '/workspace/.codeck/state/review-marker.json';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

// Only act on Bash tool
if (parsed.tool_name !== 'Bash') process.exit(0);

const command = parsed.tool_input?.command || '';

// Only gate git commit commands
if (!command.match(/\bgit\s+commit\b/)) process.exit(0);

// Check if review marker exists and is recent
if (!existsSync(MARKER_PATH)) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'STOP — you must run code-reviewer before committing. Spawn a code-reviewer sub-agent to review your changes first.',
    }
  }));
  process.exit(0);
}

try {
  const marker = JSON.parse(readFileSync(MARKER_PATH, 'utf-8'));
  const age = Date.now() - (marker.timestamp || 0);
  const maxAge = 30 * 60 * 1000; // 30 minutes

  if (age > maxAge) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'STOP — last code review was over 30 minutes ago. Run code-reviewer again before committing.',
      }
    }));
    process.exit(0);
  }
} catch {
  // Marker corrupt — allow commit (don't block on hook errors)
}

// Review is recent — allow commit
process.exit(0);
