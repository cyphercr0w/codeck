---
name: rpi-implement
description: "Implement phase — execute the plan with implementer + reviewer agents."
argument-hint: "[feature-slug]"
model: sonnet
allowed-tools: "Agent, Read, Grep, Glob, Bash, Write, Edit, TaskCreate, TaskUpdate, TaskList"
---

# RPI Implement Phase

You are orchestrating the Implement phase of the RPI workflow.

## Input
The user provides a feature slug: $ARGUMENTS
Read `rpi/{feature-slug}/PLAN.md` for the implementation plan.

## Your Job

For each phase in the plan:

1. Create tasks from the plan using TaskCreate
2. Spawn an **implementer** agent (subagent_type: "implementer") with:
   - The specific tasks for this phase
   - File paths to modify
   - Acceptance criteria
   - Context from previous phases (if any)
3. After implementation, spawn a **code-reviewer** agent (subagent_type: "code-reviewer") to review the changes
4. If reviewer requests changes, send feedback to implementer
5. Once reviewer approves, move to next phase

After all phases:
1. Run the build/test command if available
2. Write implementation summary to `rpi/{feature-slug}/IMPLEMENT.md`
3. Report results to the user

## Rules
- Execute phases sequentially (phase N+1 depends on phase N)
- ALWAYS review after each phase — never skip review
- If a phase fails after 2 attempts, stop and report to user
- Track progress with TaskUpdate
