---
name: autonomous-harness
description: Use for large, multi-step, or long-running tasks that must run to completion with minimal supervision — features spanning many files, migrations/sweeps, or anything that should survive context compaction and session restarts. Drives a resumable verify-until-done loop with persistent state on disk, a hard budget/iteration cap, and independent verification before anything is marked done. Invoked by /harness.
metadata:
  origin: Codeck
tools: Read, Write, Edit, Bash, Grep, Glob
---

# Autonomous Harness — verify-until-done, resumable, budget-capped

This is the long-running arm of the Autonomous Operator Protocol. It turns a **PO-vetted** plan into durable, resumable state and grinds it to completion **autonomously** — the **`product-owner` (PO)** agent renders the verdicts a human sponsor would (plan approval, each review/audit round, and DONE), and the Stop-loop keeps you alive and on-track until DONE. Anthropic's verified pattern for long-running agents: an initializer sets up progress + requirements, then each iteration reads progress → does ONE unit → verifies end-to-end → commits → updates progress. Agents "mark features complete without testing" — so **nothing is done without opened evidence**.

## State (on the workspace bind — survives compaction, restart, rebuild)

```
/workspace/.codeck/harness/current.json          { "active": true, "taskId": "<id>" }
/workspace/.codeck/harness/<taskId>/plan.md        the vetted surgical plan
/workspace/.codeck/harness/<taskId>/requirements.json  acceptance criteria (definition of done)
/workspace/.codeck/harness/<taskId>/progress.json  criteria status + evidence + iteration log
/workspace/.codeck/harness/<taskId>/budget.json    { iterCap, costCapUsd, iterations, spentUsd }
/workspace/.codeck/harness/<taskId>/overseer.json  Product-Owner state (drives the Stop-loop)
```

`requirements.json`: `[{ "id": "c1", "desc": "...", "status": "todo|doing|done", "evidence": "" }]`.
`overseer.json`: `{ "mode": "autonomous|supervised", "phase": "plan|implement|review|audit|done", "planApproved": <bool>, "done": <bool>, "escalated": <bool>, "directive": "<next step>", "reprompts": <int>, "updatedAt": <ms> }` — written by the `product-owner` agent at each verdict. The `workflow-checkpoint` Stop hook reads it: while `active` and not `done`/`escalated`, a premature stop is **blocked and auto-reprompted** with the pending directive (the keep-alive), until the PO declares DONE or the budget cap hits.
`budget.json` defaults: `{ "iterCap": 200, "costCapUsd": 10, "iterations": 0, "spentUsd": 0 }` — adjust to the task, confirm with the user if raising. The `budget-guard` hook hard-stops you at the cap.

## Procedure

### 0. Resume check (ALWAYS first)
If `current.json` exists and `active:true`, read that task's `plan.md` + `progress.json` and **continue from the first not-done criterion** — do not restart, do not re-plan. Announce what you're resuming.

### 1. Initialize (new task only)
- **Capability preflight.** Run `node /workspace/.codeck/scripts/capability-doctor.mjs --json` and confirm every capability this task depends on (git remote/push, `gh`, Docker, headless browser, network, disk) is ready. `which` ≠ ready. If a required one is NOT ready, resolve it, take its documented fallback, or surface it to the user **before** committing to a long unattended run — do not start a run that will stall on a missing capability.
- **Clarify + mode:** clarify to zero ambiguity (Protocol Phase 1), and ask ONCE — autonomous (PO decides) or supervised (user decides)? Default autonomous.
- Pick a `taskId` (kebab slug). Write `current.json` (`active:true`), `overseer.json` (`mode`, `phase:"plan"`, `planApproved:false`, `done:false`, `reprompts:0`), and `budget.json`. **Clear stale gate state from any prior task** so old markers can't satisfy this task's gates: `rm -f /workspace/.codeck/state/review-marker.json /workspace/.codeck/state/audit-marker.json /workspace/.codeck/state/edit-tracker.json`.
- **Plan + plan-review loop:** produce the surgical plan → `plan.md`; derive **acceptance criteria** → `requirements.json` (every criterion `status:"todo"`). Then run the **plan-review loop** (`spec-reviewer` + `architect` + `grader`), fix and re-review until ZERO findings, and consult the **`product-owner`** for the PLAN verdict. Implement only after `APPROVE_PLAN` (PO sets `planApproved:true`). In supervised mode, present the vetted plan to the user instead.
- `git add -A && git commit` an initial checkpoint (anchor state in git, not just conversation).

### 2. Iterate (the loop)
Repeat until every criterion is `done` or the budget-guard stops you:
1. Read `progress.json`; pick the next `todo`/`doing` criterion. Mark it `doing`.
2. Do **ONE** coherent unit of work toward it (thin slice; small verifiable change). Spawn subagents freely for isolated pieces (route: haiku=read/test, sonnet=build, opus=review). Route by playbook (`rules/base/playbooks.md`).
3. **Verify end-to-end** — build + tests, and for anything user-facing run `visual-verifier`; grade with `grader` where the criterion is subtle. A criterion flips to `done` ONLY with a linked evidence artifact (test output, diff, screenshot). Criteria start false.
4. Write memory (daily log) + update `progress.json` (status + evidence + a one-line iteration note), and update `spentUsd` in `budget.json` from the session cost so far (so the cost cap can engage — the iteration cap fires automatically regardless). `git commit` the increment.
5. If stuck (same failure ~3×, or the no-progress guard fires): stop guessing, re-plan that criterion or ask the user. Never loop blindly.

### 3. Finalize
When all criteria are `done`: run the **review→audit loop** — `code-reviewer`, then `security-reviewer` + `grader` — fixing everything and **re-reviewing until ZERO findings**; write the review/audit markers `{clean:true}`. Consult the **`product-owner`** for the **DONE verdict**: it confirms every criterion has linked evidence and sets `overseer.done=true`. Only then set `current.json` `active:false` and present the result with the evidence per criterion. If the PO returns NOT_DONE or ITERATE, keep looping (the Stop hook will auto-reprompt you). If genuinely blocked, the PO returns ESCALATE — surface it to the user.

## Rules
- **The PO drives; you don't stop to ask the user.** Route plan/review/done decisions to the `product-owner`; only its ESCALATE hands control back to a human. A premature stop is auto-reprompted with the next directive — keep working until DONE.
- **Idempotent & git-anchored:** every increment is committed, so a restart resumes from real state, not memory.
- **Never mark done without evidence.** Never weaken tests to pass (the grader checks for this).
- **Respect the budget cap.** Raising it needs the user's explicit go-ahead.
- **Never touch the live/online container.** Verify in-session; the user deploys.
