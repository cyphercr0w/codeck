---
name: agent-introspection-debugging
description: Structured recovery protocol for when YOU (the agent) are stuck — a tool keeps failing, the same fix isn't working, the build won't go green, or a loop is thrashing. Use the moment you notice repetition instead of retrying a 4th time. Turns blind retry into capture → diagnose → contained recovery → introspection, and decides between re-plan, fall back, or ESCALATE. Pairs with the `no-progress-guard` hook and the 3-retries rule.
origin: adapted from affaan-m/ecc (MIT) — agent-introspection-debugging, tuned to Codeck's harness
---

# Agent Introspection & Debugging — stop thrashing, recover deliberately

Blind retry is the top failure mode of an autonomous, self-reprompting run: the same broken tool call or non-working fix repeated until the budget burns. The `no-progress-guard` hook will flag it, but **you should catch it first**. The instant you notice you're repeating an approach (≈2nd identical failure, not the 3rd), STOP and run this protocol instead of trying again.

## Phase 1 — Capture (freeze the actual state)
Do not theorize yet. Gather the ground truth:
- The **exact** error text / stack / exit code — read it fully, don't skim.
- What you *expected* vs what *happened* (one line each).
- Recent diffs and the last command that changed behavior (`git diff`, last edit).
- Relevant environment facts — re-check with `node /workspace/.codeck/scripts/capability-doctor.mjs --json` (a "bug" is often a missing/unauthenticated capability, not your code).

## Phase 2 — Diagnose (classify before fixing)
Put the failure in exactly one bucket — the bucket dictates the fix:
- **Logic** — your code/plan is wrong. → re-read the code path; write/keep a failing test that captures it; fix the root cause, not the symptom.
- **State** — stale cache, uncommitted/partial change, dirty worktree, leftover process/port. → reset the state (clean build, kill the process, reconcile git), then retry once.
- **Environment** — missing tool, unauthenticated `gh`, daemon down, no network, no disk. → take the capability's documented fallback or surface it; do NOT keep retrying code against a broken environment.
- **Policy** — a hook denied it, a permission/guard blocked it, budget cap hit. → read the denial reason; comply or route the decision to the `product-owner`. Never try to bypass a guard.

If you cannot place it in a bucket, you don't understand it yet — gather more evidence (Phase 1), don't guess.

## Phase 3 — Contained recovery (one deliberate move)
- Make **one** change that targets the diagnosed bucket, then verify end-to-end. Not a scattershot of edits.
- If it was State/Environment, prefer *reset then retry once* over *retry as-is*.
- Respect **3 retries max on the same approach**. Attempt 4 of the same thing is forbidden — change the approach or escalate.

## Phase 4 — Introspection (decide the next lane)
Restate, in one line, the hypothesis you just tested and whether it held. Then choose:
- **Fixed** → continue the run; write the root cause + fix to the daily log so it's not rediscovered.
- **New information, different approach** → re-plan that slice (Protocol Phase 3) with the evidence; try the new approach.
- **Genuinely blocked** (needs info no agent can get, an external outage, or a decision above your authority) → in an autonomous run, hand it to the `product-owner` as **ESCALATE** with a crisp one-line question; the PO surfaces it to the user. Escalate is cheap compared to thrashing — use it rather than looping.

## Rules
- Trigger on the **2nd** repetition, not the 3rd — you have less runway than you think.
- One hypothesis, one change, one verification per cycle. No shotgun debugging.
- "It should work" is not evidence. Open the artifact (log/test/diff) that proves it.
- Never weaken a test, silence an error, or bypass a guard to make red turn green — that converts a visible bug into a hidden one (the `grader`/`silent-failure-hunter` will catch it anyway).
