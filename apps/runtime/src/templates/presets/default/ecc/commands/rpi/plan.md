---
name: rpi-plan
description: "Plan phase — create detailed implementation plan from research. Spawns planner agent."
argument-hint: "[feature-slug]"
model: sonnet
allowed-tools: "Agent, Read, Grep, Glob, Bash, Write, TaskCreate, TaskUpdate, TaskList"
---

# RPI Plan Phase

You are orchestrating the Plan phase of the RPI workflow.

## Input
The user provides a feature slug: $ARGUMENTS
Read `rpi/{feature-slug}/RESEARCH.md` and `rpi/{feature-slug}/REQUEST.md` for context.

## Your Job

1. Verify RESEARCH.md exists and verdict is GO
2. Spawn a **planner** agent (subagent_type: "planner") with the full context (REQUEST.md + RESEARCH.md content) to create:
   - Implementation phases (2-4 phases)
   - Tasks per phase with clear acceptance criteria
   - File ownership (which files each task touches)
   - Dependencies between tasks
   - Testing strategy
3. Write the plan to `rpi/{feature-slug}/PLAN.md` with:
   - **Overview**: What we're building and why
   - **Phases**: Ordered list with tasks
   - **Task Details**: For each task: description, files, acceptance criteria, estimated effort
   - **Dependencies**: What blocks what
   - **Testing**: How to verify each phase
   - **Risks**: From the research, plus any new ones

## Output
Tell the user the plan is ready and suggest running `/rpi-implement {feature-slug}`.
