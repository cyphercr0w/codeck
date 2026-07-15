---
name: autonomous-harness
description: Use for large, multi-step, or long-running tasks that must run to completion with minimal supervision — features spanning many files, migrations/sweeps, or anything that should survive context compaction and session restarts. Drives a resumable verify-until-done loop with persistent state on disk, a hard budget/iteration cap, and independent verification before anything is marked done. Invoked by /harness.
metadata:
  origin: Codeck
tools: Read, Write, Edit, Bash, Grep, Glob
---

# Autonomous Harness — verify-until-done, resumable, budget-capped

This is the long-running arm of the Autonomous Operator Protocol. It turns an approved plan into durable, resumable state and grinds it to completion. Anthropic's verified pattern for long-running agents: an initializer sets up progress + requirements, then each iteration reads progress → does ONE unit → verifies end-to-end → commits → updates progress. Agents "mark features complete without testing" — so **nothing is done without opened evidence**.

## State (on the workspace bind — survives compaction, restart, rebuild)

```
/workspace/.codeck/harness/current.json          { "active": true, "taskId": "<id>" }
/workspace/.codeck/harness/<taskId>/plan.md        the approved surgical plan
/workspace/.codeck/harness/<taskId>/requirements.json  acceptance criteria (definition of done)
/workspace/.codeck/harness/<taskId>/progress.json  criteria status + evidence + iteration log
/workspace/.codeck/harness/<taskId>/budget.json    { iterCap, costCapUsd, iterations, spentUsd }
```

`requirements.json`: `[{ "id": "c1", "desc": "...", "status": "todo|doing|done", "evidence": "" }]`.
`budget.json` defaults: `{ "iterCap": 200, "costCapUsd": 10, "iterations": 0, "spentUsd": 0 }` — adjust to the task, confirm with the user if raising. The `budget-guard` hook hard-stops you at the cap.

## Procedure

### 0. Resume check (ALWAYS first)
If `current.json` exists and `active:true`, read that task's `plan.md` + `progress.json` and **continue from the first not-done criterion** — do not restart, do not re-plan. Announce what you're resuming.

### 1. Initialize (new task only)
- Complete Protocol Phase 1–2 first: clarify to zero ambiguity, produce the surgical plan, get approval. Derive the **acceptance criteria** from the plan.
- Pick a `taskId` (kebab slug). Write `plan.md`, `requirements.json` (every criterion `status:"todo"`), `budget.json`, and `current.json` (`active:true`).
- `git add -A && git commit` an initial checkpoint (anchor state in git, not just conversation).

### 2. Iterate (the loop)
Repeat until every criterion is `done` or the budget-guard stops you:
1. Read `progress.json`; pick the next `todo`/`doing` criterion. Mark it `doing`.
2. Do **ONE** coherent unit of work toward it (thin slice; small verifiable change). Spawn subagents freely for isolated pieces (route: haiku=read/test, sonnet=build, opus=review). Route by playbook (`rules/base/playbooks.md`).
3. **Verify end-to-end** — build + tests, and for anything user-facing run `visual-verifier`; grade with `grader` where the criterion is subtle. A criterion flips to `done` ONLY with a linked evidence artifact (test output, diff, screenshot). Criteria start false.
4. Write memory (daily log) + update `progress.json` (status + evidence + a one-line iteration note). `git commit` the increment.
5. If stuck (same failure ~3×, or the no-progress guard fires): stop guessing, re-plan that criterion or ask the user. Never loop blindly.

### 3. Finalize
When all criteria are `done`: run the full Review → Audit gate (`code-reviewer` → `security-reviewer` + `grader`), write the review/audit markers, fix anything found, then set `current.json` `active:false` and present the result with the evidence per criterion.

## Rules
- **Idempotent & git-anchored:** every increment is committed, so a restart resumes from real state, not memory.
- **Never mark done without evidence.** Never weaken tests to pass (the grader checks for this).
- **Respect the budget cap.** Raising it needs the user's explicit go-ahead.
- **Never touch the live/online container.** Verify in-session; the user deploys.
