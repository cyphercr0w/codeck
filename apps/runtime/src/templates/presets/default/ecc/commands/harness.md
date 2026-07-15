---
description: Run a task in the autonomous long-running harness — resumable state, budget cap, verify-until-done loop. For large multi-step work.
argument-hint: [task description]
---

Load the `autonomous-harness` skill and run the task below through it end to end.

Task: $ARGUMENTS

Follow the harness procedure exactly:
1. If a harness task is already active (`.codeck/harness/current.json`), **resume it** instead of starting a new one.
2. Otherwise, first complete Phase 1–2 of the Autonomous Operator Protocol (clarify to zero ambiguity via AskUserQuestion, then a surgical plan with acceptance criteria) and get approval.
3. Then initialize harness state and run the verify-until-done loop until every acceptance criterion passes with evidence, or the budget cap stops you.
