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

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const HARNESS = '/workspace/.codeck/harness';
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

const budgetPath = join(HARNESS, String(cur.taskId), 'budget.json');
if (!existsSync(budgetPath)) process.exit(0);

let b;
try { b = JSON.parse(readFileSync(budgetPath, 'utf-8')); } catch { process.exit(0); }

const iterCap = Number.isFinite(b.iterCap) ? b.iterCap : 200;
const costCap = Number.isFinite(b.costCapUsd) ? b.costCapUsd : Infinity;
const spent = Number.isFinite(b.spentUsd) ? b.spentUsd : 0;

// Increment the iteration counter for this expensive action.
b.iterations = (Number.isFinite(b.iterations) ? b.iterations : 0) + 1;
try { writeFileSync(budgetPath, JSON.stringify(b, null, 2)); } catch { /* best effort */ }

const overIter = b.iterations > iterCap;
const overCost = spent > costCap;

if (overIter || overCost) {
  const why = overCost
    ? `cost cap reached ($${spent.toFixed(2)} > $${costCap})`
    : `iteration cap reached (${b.iterations} > ${iterCap})`;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `HARNESS BUDGET STOP: ${why}. Do NOT continue automatically. Stop, write the current progress to .codeck/harness/${cur.taskId}/progress.json, and report to the user what is done, what remains, and whether to raise the cap. Raising the cap requires the user's explicit go-ahead.`,
    },
  }));
  process.exit(0);
}

// Warn as we approach the ceiling.
if (b.iterations > iterCap * 0.8) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `Harness budget: ${b.iterations}/${iterCap} iterations used. Prioritize finishing the remaining criteria; you will be hard-stopped at the cap.`,
    },
  }));
}
