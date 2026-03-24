#!/usr/bin/env node
/**
 * Subagent lifecycle tracker — posts SubagentStart/SubagentStop events
 * to the Codeck runtime so the web UI can show a real-time panel.
 *
 * Registered as a hook for both SubagentStart and SubagentStop events.
 * Reads the event JSON from stdin and forwards it to the runtime API.
 */

import { request } from 'http';

const input = await new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', chunk => { data += chunk; });
  process.stdin.on('end', () => {
    try { resolve(JSON.parse(data)); }
    catch { resolve(null); }
  });
  // Timeout after 2s if no input
  setTimeout(() => resolve(null), 2000);
});

if (!input || !input.hook_event_name) process.exit(0);

const payload = JSON.stringify({
  event: input.hook_event_name,
  agentId: input.agent_id || 'unknown',
  agentType: input.agent_type || 'unknown',
  sessionId: input.session_id || '',
  cwd: input.cwd || '',
  transcriptPath: input.agent_transcript_path || '',
  lastMessage: input.last_assistant_message
    ? input.last_assistant_message.slice(0, 500)
    : undefined,
});

// Fire and forget — don't block Claude Code
// Use 127.0.0.1 (not localhost) to hit the runtime directly without proxy auth
const port = parseInt(process.env.CODECK_PORT || '80', 10);
const req = request(
  { hostname: '127.0.0.1', port, path: '/api/console/subagents', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    timeout: 2000 },
  () => {}
);
req.on('error', () => {});
req.write(payload);
req.end();
