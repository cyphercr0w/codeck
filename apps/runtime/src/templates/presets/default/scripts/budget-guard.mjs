#!/usr/bin/env node
/**
 * PreToolUse Hook — Hard budget / iteration kill switch for the autonomous harness.
 *
 * Only active while a harness task is running (.codeck/harness/current.json with
 * active=true). It counts "expensive" actions (Bash/Edit/Write/Agent) and DENIES
 * the next one once the iteration or cost cap is hit — the harness stops before
 * turning a small mistake into an expensive runaway. Normal (non-harness) work is
 * never touched.
 *
 * State (managed by the harness skill):
 *   .codeck/harness/current.json         { active, taskId }
 *   .codeck/harness/<taskId>/budget.json { iterCap, costCapUsd, iterations, spentUsd }
 *
 * The ITERATION cap is the deterministic hard ceiling — this hook increments
 * `iterations` itself, so it always fires. The COST cap is best-effort: it only
 * engages if the harness loop keeps `spentUsd` current (the skill updates it each
 * iteration); if it doesn't, only the iteration cap protects you. PreToolUse can
 * hard-deny (permissionDecision:"deny") even under bypass mode, so the ceiling is
 * real, not a suggestion.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const HARNESS = process.env.CODECK_HARNESS_DIR || '/workspace/.codeck/harness';
const CURRENT = join(HARNESS, 'current.json');

let input = '';
for await (const chunk of process.stdin) input += chunk;

let data;
try { data = JSON.parse(input); } catch { process.exit(0); }

// Only guard expensive/mutating tools.
const tool = data.tool_name || '';
if (!/^(Bash|Edit|Write|MultiEdit|Agent)$/.test(tool)) process.exit(0);

// Only active during a harness run.
if (!existsSync(CURRENT)) process.exit(0);
let cur;
try { cur = JSON.parse(readFileSync(CURRENT, 'utf-8')); } catch { process.exit(0); }
if (!cur || cur.active !== true || !cur.taskId) process.exit(0);

// Writes/commands that checkpoint or close the harness itself are ALWAYS allowed
// (a capped run must still record progress / ESCALATE / set active:false). They
// are still COUNTED below, so they can't be used to dodge the iteration cap.
const HARNESS_STATE_RE = /\.codeck[\/\\]harness[\/\\]/;
const HARNESS_WRITE_RE = /(>>?|\btee\b|\bcp\b|\bmv\b)\s+[^|;&]*\.codeck[\/\\]harness[\/\\]/;
const filePath = String(data.tool_input?.file_path || '');
const bashCmd = String(data.tool_input?.command || '');
const isHarnessWrite =
  ((tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') && HARNESS_STATE_RE.test(filePath)) ||
  (tool === 'Bash' && HARNESS_WRITE_RE.test(bashCmd));

const taskDir = join(HARNESS, String(cur.taskId));
const budgetPath = join(taskDir, 'budget.json');
// Fail CLOSED: a missing/corrupt budget.json must NOT silently disable the cap.
let b;
try { b = JSON.parse(readFileSync(budgetPath, 'utf-8')); } catch { b = null; }
if (!b || typeof b !== 'object' || Array.isArray(b)) b = { iterCap: 200, costCapUsd: 10, iterations: 0, spentUsd: 0 };

const iterCap = Number.isFinite(b.iterCap) ? b.iterCap : 200;
const costCap = Number.isFinite(b.costCapUsd) ? b.costCapUsd : Infinity;
const spent = Number.isFinite(b.spentUsd) ? b.spentUsd : 0;

// COUNT every guarded action — INCLUDING harness writes. mkdir first so a partial/
// manually-seeded state can't make the write throw and silently reset the counter.
b.iterations = (Number.isFinite(b.iterations) ? b.iterations : 0) + 1;
try {
  if (!existsSync(taskDir)) mkdirSync(taskDir, { recursive: true });
  writeFileSync(budgetPath, JSON.stringify(b, null, 2));
} catch { /* best effort */ }

const overCap = b.iterations > iterCap || spent > costCap;

if (overCap) {
  // SELF-HEAL: end the task (active:false) so the lockout can never persist and
  // the next call passes this guard (active:false → early exit).
  try { writeFileSync(CURRENT, JSON.stringify({ ...cur, active: false, stoppedBy: 'budget-guard', stoppedAt: Date.now() }, null, 2)); } catch { /* best effort */ }
  // Harness-state write: allow it (checkpoint/close) — it was already counted.
  if (isHarnessWrite) process.exit(0);
  const why = spent > costCap
    ? `cost cap reached ($${spent.toFixed(2)} > $${costCap})`
    : `iteration cap reached (${b.iterations} > ${iterCap})`;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `HARNESS BUDGET STOP: ${why}. The task has been stopped (current.json active:false) so tools are usable again on your next call. Write final progress to .codeck/harness/${cur.taskId}/progress.json and report to the user what is done, what remains, and whether to raise the cap (raising it needs the user's explicit go-ahead).`,
    },
  }));
  process.exit(0);
}

// Under cap: harness writes pass silently (already counted).
if (isHarnessWrite) process.exit(0);

// Warn as we approach the ceiling.
if (b.iterations > iterCap * 0.8) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `Harness budget: ${b.iterations}/${iterCap} iterations used. Prioritize finishing the remaining criteria; you will be hard-stopped at the cap.`,
    },
  }));
}
