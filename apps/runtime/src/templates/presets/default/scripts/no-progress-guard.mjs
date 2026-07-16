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

const WINDOW = 8; // rolling window to catch A,B,A,B oscillations, not just A,A,A
let state = { last: '', streak: 0, window: [] };
try { if (existsSync(HIST)) state = { window: [], ...JSON.parse(readFileSync(HIST, 'utf-8')) }; } catch { /* reset */ }

// Consecutive-repeat streak…
state.streak = (sig === state.last) ? (state.streak + 1) : 1;
state.last = sig;
// …and a windowed occurrence count so a two-step failing cycle (edit→test→edit→
// test, both failing) is caught even though no two consecutive calls are identical.
state.window = [...(Array.isArray(state.window) ? state.window : []), sig].slice(-WINDOW);
const occ = state.window.filter((s) => s === sig).length;
const repeat = Math.max(state.streak, occ);

try { writeFileSync(HIST, JSON.stringify(state)); } catch { /* best effort */ }

if (repeat < WARN_AT) process.exit(0);

const how = state.streak >= occ ? `${repeat} times in a row` : `${repeat} times in the last ${WINDOW} calls (a repeating cycle)`;
const message = repeat >= HARD_AT
  ? `LOOP DETECTED: the same ${tool} call has occurred ${how} with no change. STOP repeating. Re-read the last error, change the approach, or ESCALATE — do not retry the same call again (3-retries rule). If you are stuck, surface it instead of looping.`
  : `No-progress warning: ${tool} call repeated ${how}. If it keeps failing, change the approach rather than retrying — you have ${HARD_AT - repeat} before this is treated as a stuck loop.`;

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: message,
  },
}));
