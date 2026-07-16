# Task Playbooks

The `task-classifier` hook tags each task with a type and points you here. Each playbook is a specialization of the **Autonomous Operator Protocol** (`workflow.md`) — same phases (clarify+mode → plan → **PO plan-review loop** → implement → **review→audit loop** → **PO DONE**, iterate), tuned per task type. Decisions are the **`product-owner`**'s, not the user's (autonomous mode). For large multi-step work, run the **`autonomous-harness` skill** (`/harness`) which drives this loop with persistent, resumable state, a PO decision layer, and a hard budget cap.

## When to escalate parallelism (read-parallel, write-serial)

Default to a **single agent**. Escalate only as the task demands, cheapest first:
- **Subagents** (Agent tool, isolated context, return a summary) — your default workhorse for research, review, exploration, and independent read/analysis. Use freely.
- **Agent Teams** (persistent teammates + shared task list) — ONLY for genuinely independent parallel *workstreams* (multi-file audits, fan-out research, generating competing candidates). Never for tightly-coupled coding — parallel writers make conflicting decisions. Partition writes by file/module; keep synthesis single-agent.

---

## feature — build something new
1. **Clarify:** intended behavior, scope, UX, data/API contracts, and the exact acceptance criteria (definition of done).
2. **Plan → PO verdict:** files to create/change, every affected path, tests, rollback. Use `architect`/`planner` for non-trivial design. Run the plan-review loop (`spec-reviewer`+`architect`+`grader`) to zero findings, then the `product-owner` approves — no user gate in autonomous mode.
3. **Implement:** thin vertical slice first (make it work end-to-end), then flesh out. Write tests alongside.
4. **Review → Audit (loop):** `code-reviewer` + `silent-failure-hunter` → `security-reviewer` + `grader` (completeness vs criteria) → `visual-verifier` if it has a UI; dedup findings, adversarially verify each CRITICAL/HIGH, fix and re-review until zero findings (fail-closed).
5. **PO DONE → deliver** only when every criterion has linked evidence.

## bugfix — something is broken
1. **Reproduce first.** Do not fix what you cannot reproduce — write a failing test that captures the bug.
2. **Root-cause** with `debugger`/`error-detective`, not symptom-patching. Read the actual error/trace.
3. **Minimal fix** at the root cause; keep the failing test and make it pass.
4. **Regression guard:** ensure the test would have caught it; check for the same bug pattern elsewhere.
5. Review → deliver with the now-passing test as evidence.

## refactor — change structure, not behavior
1. **Characterization first:** ensure tests cover current behavior BEFORE touching anything (add them if missing).
2. **Small, behavior-preserving steps**; build/test green after each. Never mix refactor + feature in one step.
3. **Prove no behavior change:** same tests pass before and after; diff is structural only.
4. Review focuses on "did behavior stay identical?" Deliver with green tests as evidence.

## research — investigate / answer a question
1. **Scope the question** to zero ambiguity (what decision does this inform?).
2. **Fan out** read-only subagents (`Explore`) across sources in parallel — this is where multi-agent WINS.
3. **Adversarially verify** load-bearing claims (a second agent tries to refute) before reporting.
4. Deliver a **cited, hedged** synthesis — flag what's unverified. No code changes; save findings to memory.

## migration — sweep across many sites
1. **Discover the full work-list first** (grep/scan every affected site) — never assume you found them all; `log` what's in scope.
2. **Plan the transform** on ONE representative site; get approval on the pattern.
3. **Apply per-site**, ideally with `isolation: worktree` subagents for parallelism; verify each independently (tests/build).
4. **Reconcile & verify the whole**: count sites done vs discovered; no silent truncation. This is a prime `/harness` candidate (resumable, budget-capped).

## ops — deploy / infra / CI
1. **Clarify blast radius** and rollback path BEFORE acting. Confirm anything irreversible or outward-facing.
2. **Dry-run / plan** first (`--dry-run`, `plan`, staging). Never run destructive infra without a confirmed rollback.
3. **Idempotent, observable** steps; verify health after each.
4. **Never touch the live/online container** unless explicitly authorized. Back up state first.

## debug — diagnose without a known fix
1. **Form a hypothesis**, then instrument to confirm/deny it — don't guess-and-check blindly.
2. **Bisect**: narrow the failing surface (git bisect, binary search on inputs, disable-half).
3. Once root cause is proven, hand off to the **bugfix** playbook.

## trivial — small & unambiguous
Read/answer/one-line fix: do it directly. Still write memory if the result matters. No plan gate needed.
