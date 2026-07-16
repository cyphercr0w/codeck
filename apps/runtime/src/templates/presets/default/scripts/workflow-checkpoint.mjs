#!/usr/bin/env node
/**
 * Stop Hook — Workflow Checkpoint + Autonomous Overseer gate.
 *
 * Two regimes:
 *
 * A) An autonomous harness task is active (`.codeck/harness/current.json`
 *    active=true) — the **Product Owner (PO) self-reprompt loop**. The run does
 *    not stop for a human; it stops only when the PO has declared the feature
 *    DONE (with evidence), or ESCALATED, or the budget/reprompt cap is hit. On
 *    any premature stop this hook BLOCKS and injects the pending directive
 *    (compute-from-state if the PO hasn't written one) — that block IS the
 *    auto-prompt that keeps the orchestra alive and on track. Enforces the two
 *    loops: plan-review (PO must APPROVE_PLAN before implementation) and
 *    review→audit (clean markers before the DONE verdict).
 *
 * B) No harness task — the legacy review/audit gate: significant edits (5+
 *    files) must see a code-reviewer, then an audit, before the lead may stop.
 *    Unchanged, so ordinary quick tasks are not over-blocked.
 *
 * Output (Claude Code Stop hook contract):
 *   { "result": "approve" }                                  — let Claude stop
 *   { "result": "block", "reason": "...", "message": "..." } — force continue
 */

// Teammates (sub-agents) skip this hook — only the lead needs it
if (process.env.CLAUDE_CODE_TEAM_NAME) process.exit(0);

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const STATE_DIR = process.env.CODECK_STATE_DIR || '/workspace/.codeck/state';
const HARNESS_DIR = process.env.CODECK_HARNESS_DIR || '/workspace/.codeck/harness';
const CURRENT = join(HARNESS_DIR, 'current.json');
const EDIT_TRACKER = join(STATE_DIR, 'edit-tracker.json');
const REVIEW_MARKER = join(STATE_DIR, 'review-marker.json');
const AUDIT_MARKER = join(STATE_DIR, 'audit-marker.json');
const MAX_REPROMPTS = 60; // backstop above budget-guard's iteration cap

// Read stdin (Stop hook payload) — drained, not otherwise needed.
let input = '';
for await (const chunk of process.stdin) input += chunk;

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

function readJSON(path, fallback) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : fallback; }
  catch { return fallback; }
}
function approve() { console.log(JSON.stringify({ result: 'approve' })); process.exit(0); }
function block(reason, message) { console.log(JSON.stringify({ result: 'block', reason, message })); process.exit(0); }

const edits = readJSON(EDIT_TRACKER, { files: [], count: 0, since: 0 });
const since = Number(edits.since || 0);

// A marker "satisfies" a gate only if it is newer than the edits AND (in the
// strict harness regime) was written clean (findings resolved / re-reviewed).
function markerOk(path, requireClean) {
  const m = readJSON(path, null);
  if (!m || !m.timestamp || m.timestamp <= since) return false;
  return requireClean ? m.clean === true : true;
}

// If sub-agents are genuinely still working (async/team), don't block yet.
function subagentsActive() {
  const subs = readJSON(join(STATE_DIR, 'active-subagents.json'), null);
  return !!(subs && subs.count > 0 && (Date.now() - subs.lastUpdate) < 600000);
}

// ── Regime A: autonomous overseer (PO) self-reprompt loop ────────────────────
const cur = readJSON(CURRENT, null);
if (cur && cur.active === true && cur.taskId) {
  const taskDir = join(HARNESS_DIR, String(cur.taskId));
  const overseer = readJSON(join(taskDir, 'overseer.json'), {});
  const reqs = readJSON(join(taskDir, 'requirements.json'), []);

  // Supervised mode → hand delivery to the user via the legacy gate below.
  if (overseer.mode && overseer.mode !== 'autonomous') {
    // fall through to Regime B
  } else {
    // Budget cap is the PRIMARY hard stop — mirror budget-guard here so the Stop
    // loop doesn't ping-pong against a PreToolUse that is already denying every
    // action (including the PO's own writes). If the cap is hit, let it stop; the
    // lead surfaces "done vs remaining" to the user per budget-guard's message.
    const budget = readJSON(join(taskDir, 'budget.json'), {});
    const iterCap = Number.isFinite(budget.iterCap) ? budget.iterCap : 200;
    const costCap = Number.isFinite(budget.costCapUsd) ? budget.costCapUsd : Infinity;
    const iterations = Number.isFinite(budget.iterations) ? budget.iterations : 0;
    const spentUsd = Number.isFinite(budget.spentUsd) ? budget.spentUsd : 0;
    if (iterations > iterCap || spentUsd > costCap) approve();

    // ESCALATE is the only *deliberate* path that returns control to a human.
    if (overseer.escalated === true) approve();

    // Reprompt backstop (secondary safety, below the budget cap).
    const reprompts = Number(overseer.reprompts || 0);
    if (reprompts >= MAX_REPROMPTS) approve();

    const reviewClean = markerOk(REVIEW_MARKER, true);
    const auditClean = markerOk(AUDIT_MARKER, true);
    const hasEdits = Number(edits.count || 0) > 0;

    // DONE requires ALL of: PO verdict, a NON-EMPTY requirements list with every
    // criterion done+evidence (an empty/missing/corrupt file is NOT "complete"),
    // and — if code changed — clean review AND audit markers. Defense-in-depth so
    // a lenient/buggy PO or corrupt overseer.json can't ship unverified work.
    const criteriaComplete = Array.isArray(reqs) && reqs.length > 0
      && reqs.every(c => c && c.status === 'done' && c.evidence);
    const changesVerified = !hasEdits || (reviewClean && auditClean);
    if (overseer.done === true && criteriaComplete && changesVerified) approve();

    // NOTE: no subagentsActive() early-approve in Regime A. A synchronous Agent
    // call has already returned by the time Stop fires; trusting a possibly-stuck
    // active-subagents counter could strand the run before DONE. Keep alive instead.

    let directive;
    if (!overseer.planApproved) {
      directive = 'PLAN GATE — do not implement yet. Run the plan-review loop (spawn `spec-reviewer` + `architect`/`planner` + `grader` against the definition of done); fix the plan and re-review until ZERO findings. Then consult the `product-owner` agent for the PLAN verdict. Implementation may begin only after the PO returns APPROVE_PLAN and sets overseer.planApproved=true.';
    } else if (hasEdits && !reviewClean) {
      directive = 'REVIEW LOOP — spawn `code-reviewer`, fix every finding, and re-review until clean. Then write the marker with the outcome:\n  echo \'{"timestamp":\'$(date +%s%3N)\',"agent":"code-reviewer","findings":0,"clean":true}\' > /workspace/.codeck/state/review-marker.json';
    } else if (hasEdits && reviewClean && !auditClean) {
      directive = 'AUDIT LOOP — spawn `security-reviewer` AND `grader` (completeness vs the definition of done). Every criterion needs linked evidence (criteria start false). Fix everything found and re-audit until clean. Then write the marker:\n  echo \'{"timestamp":\'$(date +%s%3N)\',"agent":"grader","findings":0,"clean":true}\' > /workspace/.codeck/state/audit-marker.json';
    } else if (!criteriaComplete) {
      directive = 'DONE GATE — checks are clean but the acceptance criteria are not fully evidenced. Ensure `.codeck/harness/' + String(cur.taskId) + '/requirements.json` is a non-empty list and every criterion is status:"done" with a linked evidence artifact (test output, diff, screenshot). Then consult the `product-owner` for the DONE verdict.';
    } else {
      directive = 'DONE GATE — review and audit are clean and criteria are evidenced. Consult the `product-owner` agent for the final DONE verdict. If it returns DONE it sets overseer.done=true and the run finalizes; otherwise fix what it flags and continue. If genuinely blocked, the PO returns ESCALATE.';
    }

    // Persist the reprompt count so the backstop and budget cap can engage.
    try {
      if (!existsSync(taskDir)) mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, 'overseer.json'), JSON.stringify({ ...overseer, reprompts: reprompts + 1, updatedAt: Date.now() }, null, 2));
    } catch { /* best effort */ }

    block(
      `Autonomous task "${cur.taskId}" is not complete (PO has not declared DONE).`,
      `Autonomous harness (Product Owner loop):\n${directive}\n\n(This run continues without user sign-off — the PO renders the verdicts. It stops only on the PO's DONE/ESCALATE verdict or the budget cap.)`
    );
  }
}

// ── Regime B: legacy review/audit gate (no active harness task) ──────────────
if (!edits.count || edits.count === 0) approve();

// Small changes (1-4 files) → approve without review.
if (edits.count <= 4) {
  writeFileSync(EDIT_TRACKER, JSON.stringify({ files: [], count: 0, since: 0 }));
  approve();
}

if (subagentsActive()) approve();

const reviewRecent = markerOk(REVIEW_MARKER, false);
const auditRecent = markerOk(AUDIT_MARKER, false);

const fileList = edits.files.slice(0, 8).join(', ');
const msg = edits.count > 8 ? `${fileList}, and ${edits.count - 8} more` : fileList;

if (reviewRecent && auditRecent) {
  writeFileSync(EDIT_TRACKER, JSON.stringify({ files: [], count: 0, since: 0 }));
  approve();
}

if (!reviewRecent) {
  block(
    `You modified ${edits.count} files (${msg}) but haven't run code-reviewer yet.`,
    `Workflow gate (review):\nYou modified ${edits.count} files (${msg}) but haven't run code-reviewer.\nSpawn a code-reviewer sub-agent, fix what it finds, then write the marker:\n  echo '{"timestamp":'$(date +%s%3N)',"agent":"code-reviewer"}' > /workspace/.codeck/state/review-marker.json`
  );
}

block(
  `Review is done but the audit gate hasn't run for ${edits.count} changed files.`,
  `Workflow gate (audit):\nCode review passed, but before delivery you must AUDIT: spawn security-reviewer AND grade completeness against the definition of done (the \`grader\` agent). Every acceptance criterion needs linked evidence (criteria start false). Fix anything found, then write the marker:\n  echo '{"timestamp":'$(date +%s%3N)',"agent":"grader"}' > /workspace/.codeck/state/audit-marker.json`
);
