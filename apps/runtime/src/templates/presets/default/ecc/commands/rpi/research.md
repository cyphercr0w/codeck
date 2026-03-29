---
name: rpi-research
description: "Research phase — analyze feasibility of a feature before planning. Spawns researcher + architect agents."
argument-hint: "[feature description]"
model: sonnet
allowed-tools: "Agent, Read, Grep, Glob, Bash, Write, TaskCreate, TaskUpdate, TaskList"
---

# RPI Research Phase

You are orchestrating the Research phase of the RPI workflow (Research → Plan → Implement).

## Input
The user provides a feature description as the argument: $ARGUMENTS

## Your Job

1. Create the feature directory: `rpi/{feature-slug}/`
2. Save the original request to `rpi/{feature-slug}/REQUEST.md`
3. Spawn a **researcher** agent (subagent_type: "researcher") to investigate:
   - Technical feasibility in the current codebase
   - Existing code that can be reused
   - Dependencies and potential conflicts
   - Estimated complexity (S/M/L/XL)
4. Spawn an **architect** agent (subagent_type: "architect") to assess:
   - Architectural fit with current system
   - Risks and tradeoffs
   - Alternative approaches
5. Synthesize findings into `rpi/{feature-slug}/RESEARCH.md` with:
   - **Verdict**: GO or NO-GO
   - **Summary**: 2-3 sentences
   - **Feasibility**: Technical analysis
   - **Architecture**: Design considerations
   - **Risks**: What could go wrong
   - **Estimate**: Complexity and effort
   - **Recommendation**: Next steps

## Output
Tell the user the verdict and where the research doc is. If GO, suggest running `/rpi-plan {feature-slug}`.
