#!/usr/bin/env node
/**
 * SessionStart / PostCompact Hook — Harness resume.
 *
 * If an autonomous-harness task is active, re-inject its state so the agent
 * resumes EXACTLY where it left off after a session restart, context compaction,
 * or container rebuild — instead of losing the thread or restarting. The state
 * lives on the workspace bind, so it survives all three.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const HARNESS = '/workspace/.codeck/harness';
const CURRENT = join(HARNESS, 'current.json');

let input = '';
for await (const chunk of process.stdin) input += chunk;

// The same hook runs on SessionStart and PostCompact; echo back the actual
// event name so the runtime routes the injected context correctly.
let payload = {};
try { payload = JSON.parse(input); } catch { /* empty payload is fine */ }
const eventName = payload.hook_event_name || 'SessionStart';

if (!existsSync(CURRENT)) process.exit(0);

let cur;
try { cur = JSON.parse(readFileSync(CURRENT, 'utf-8')); } catch { process.exit(0); }
if (!cur || cur.active !== true || !cur.taskId) process.exit(0);

const dir = join(HARNESS, String(cur.taskId));
let summary = '';
try {
  const prog = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf-8'));
  const crit = Array.isArray(prog.criteria) ? prog.criteria : (Array.isArray(prog) ? prog : []);
  const done = crit.filter((c) => c.status === 'done').length;
  const next = crit.find((c) => c.status !== 'done');
  summary = ` ${done}/${crit.length} criteria done.` + (next ? ` Next: "${next.desc || next.id}".` : '');
} catch { /* progress not readable yet */ }

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: eventName,
    additionalContext: `RESUMING HARNESS TASK "${cur.taskId}".${summary} Load the autonomous-harness skill, read .codeck/harness/${cur.taskId}/plan.md + progress.json, and CONTINUE from the first not-done criterion — do not restart or re-plan.`,
  },
}));
