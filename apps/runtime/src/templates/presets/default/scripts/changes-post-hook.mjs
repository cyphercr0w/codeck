#!/usr/bin/env node
/**
 * PostToolUse Hook (Edit|Write) — Computes and broadcasts file diff.
 *
 * Calls the changes API to compute the diff between the pre-edit snapshot
 * and the current file content, then broadcasts to the frontend.
 */

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const toolName = parsed.tool_name || '';
if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') process.exit(0);

const filePath = parsed.tool_input?.file_path || '';
if (!filePath) process.exit(0);

const sessionId = process.env.CODECK_SESSION_ID || '';
if (!sessionId) process.exit(0);

try {
  await fetch('http://127.0.0.1/api/changes/diff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, filePath }),
    signal: AbortSignal.timeout(5000),
  });
} catch {
  // Non-fatal
}

process.exit(0);
