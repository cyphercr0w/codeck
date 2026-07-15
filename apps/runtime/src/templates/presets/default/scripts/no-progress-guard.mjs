#!/usr/bin/env node
/**
 * PostToolUse Hook — No-progress / loop guard.
 *
 * Tracks a rolling history of tool-call signatures (tool name + normalized
 * input). When the SAME call repeats N times in a row, it injects an escalating
 * warning so the agent re-plans instead of hammering a broken tool. The classic
 * runaway failure is an agent calling the same failing tool hundreds of times.
 *
 * PostToolUse cannot cancel the call that already ran, so this guard escalates
 * context pressure; the hard budget/iteration ceiling lives in the Stop/budget
 * path. Deterministic — does not rely on the model noticing it is stuck.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const STATE_DIR = '/workspace/.codeck/state';
const HIST = join(STATE_DIR, 'tool-signatures.json');
const WARN_AT = 3;   // soft nudge
const HARD_AT = 5;   // strong "you are looping" message

let input = '';
for await (const chunk of process.stdin) input += chunk;

let data;
try { data = JSON.parse(input); } catch { process.exit(0); }

const tool = data.tool_name || '';
if (!tool) process.exit(0);

// Normalize input so cosmetically-different-but-equivalent calls still match.
let sigSrc = tool;
try { sigSrc += '|' + JSON.stringify(data.tool_input || {}); } catch { /* ignore */ }
const sig = createHash('sha1').update(sigSrc).digest('hex').slice(0, 16);

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

let state = { last: '', streak: 0 };
try { if (existsSync(HIST)) state = JSON.parse(readFileSync(HIST, 'utf-8')); } catch { /* reset */ }

state.streak = (sig === state.last) ? (state.streak + 1) : 1;
state.last = sig;

try { writeFileSync(HIST, JSON.stringify(state)); } catch { /* best effort */ }

if (state.streak < WARN_AT) process.exit(0);

const message = state.streak >= HARD_AT
  ? `LOOP DETECTED: you have made the same ${tool} call ${state.streak} times with no change. STOP repeating. Re-read the last error, change the approach, or ask the user — do not retry the same call again (3-retries rule). If you are stuck, surface it instead of looping.`
  : `No-progress warning: same ${tool} call repeated ${state.streak}×. If it keeps failing, change the approach rather than retrying — you have ${HARD_AT - state.streak} repeats before this is treated as a stuck loop.`;

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: message,
  },
}));
