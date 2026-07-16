#!/usr/bin/env node

/**
 * SubagentStop Hook — machine-stamps review/audit markers.
 *
 * When a real reviewer/auditor sub-agent finishes, this writes the corresponding
 * marker automatically — corroborating that the sub-agent actually ran, which a
 * hand-written `echo` cannot. The marker is stamped `clean:false` ("a review
 * happened; resolution unconfirmed"); the lead must overwrite with `clean:true`
 * only after re-reviewing to zero findings (that is what the review/audit LOOP
 * enforces). The workflow-checkpoint Stop gate reads these.
 *
 * Best-effort: if the SubagentStop payload doesn't name a known reviewer, it does
 * nothing and the manual-echo path still works — so this never blocks the flow.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';

const STATE_DIR = '/workspace/.codeck/state';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const agentName = String(
  parsed.agent_name || parsed.subagent_name || parsed.agent || parsed.name || ''
).toLowerCase();
if (!agentName) process.exit(0);

// Which gate does this reviewer corroborate?
let marker = null;
if (/code-review|silent-failure/.test(agentName)) marker = 'review-marker.json';
else if (/security-review|grader/.test(agentName)) marker = 'audit-marker.json';
if (!marker) process.exit(0);

try {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(`${STATE_DIR}/${marker}`, JSON.stringify({
    timestamp: Date.now(),
    agent: agentName,
    clean: false,   // unconfirmed — lead sets clean:true after zero-findings re-review
    findings: null,
    stampedBy: 'SubagentStop',
  }));
} catch { /* non-fatal */ }

process.exit(0);
