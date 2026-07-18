---
description: Run a task in the autonomous long-running harness — resumable state, budget cap, verify-until-done loop. For large multi-step work.
argument-hint: [task description]
---

Load the `autonomous-harness` skill and run the task below through it end to end.

Task: $ARGUMENTS

Follow the harness procedure exactly:
1. If a harness task is already active (`.codeck/harness/current.json`), **resume it** instead of starting a new one.
2. Otherwise, first complete Phase 1 of the Autonomous Operator Protocol (clarify to zero ambiguity via AskUserQuestion — the only human touchpoint) and pick the mode (autonomous, default / supervised). Then produce a surgical plan with acceptance criteria and run the plan-review loop → `product-owner` PLAN verdict (in autonomous mode the PO approves — no user gate).
3. Then initialize harness state and run the verify-until-done loop (implement → review/audit loop → PO DONE) until every acceptance criterion passes with evidence, or the budget cap stops you.
