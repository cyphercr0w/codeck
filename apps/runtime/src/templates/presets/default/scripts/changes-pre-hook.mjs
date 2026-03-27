#!/usr/bin/env node
/**
 * PreToolUse Hook (Edit|Write) — Snapshots file content before modification.
 *
 * Calls the changes API to store the current content so a diff can be computed
 * after the edit completes.
 */

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const toolName = parsed.tool_name || '';
if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') process.exit(0);

const filePath = parsed.tool_input?.file_path || '';
if (!filePath) process.exit(0);

// Get session ID from environment (set by Codeck runtime)
const sessionId = process.env.CODECK_SESSION_ID || '';
if (!sessionId) process.exit(0);

// Call the changes API
try {
  await fetch('http://127.0.0.1/api/changes/snapshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, filePath }),
    signal: AbortSignal.timeout(3000),
  });
} catch {
  // Non-fatal — snapshot failure shouldn't block the edit
}

process.exit(0);
