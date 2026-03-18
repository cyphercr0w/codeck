---
description: Review recent daily logs, extract patterns, and suggest durable memory updates
---

You are consolidating the agent's memory. This is a maintenance task.

## Steps

1. **Read recent daily logs** (last 7 days) from `/workspace/.codeck/memory/daily/`
2. **Read current durable memory** from `/workspace/.codeck/memory/MEMORY.md`
3. **Read path-scoped memory** for the current project if applicable

## Analysis

For each daily log entry, extract:
- **Patterns**: recurring decisions, approaches that worked/failed repeatedly
- **Facts**: new information about the project, user, or environment
- **Contradictions**: anything in daily logs that conflicts with durable memory

## Output

Produce a structured report:

### Suggest Adding to MEMORY.md
- [bullet points of new facts or patterns worth preserving]

### Suggest Removing from MEMORY.md
- [anything that's outdated, superseded, or no longer relevant]

### Conflicts Detected
- [contradictions between daily entries and durable memory]

### Patterns Observed
- [recurring behaviors, common errors, effective workflows]

**IMPORTANT**: Do NOT modify MEMORY.md directly. Only suggest changes. The user decides what to promote to durable memory.
