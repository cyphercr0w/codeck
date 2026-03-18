---
description: Analyze tool failure observations and suggest new rules or patterns
---

You are analyzing the agent's learning observations to identify patterns and suggest improvements.

## Steps

1. **Read observations** from `/workspace/.codeck/state/learning-observations.jsonl`
2. **Read current rules** from `/workspace/.codeck/rules/base/` and `/workspace/.codeck/rules/user/`
3. **Read current workflow** from `/workspace/.codeck/rules/base/workflow.md`

## Analysis

Group observations by:
- **Tool type**: which tools fail most often?
- **Error pattern**: what errors repeat?
- **File type**: do certain file types cause more issues?
- **Time pattern**: do failures cluster at certain times?

## Output

### Recurring Patterns
- [patterns that appear 3+ times]

### Suggested Rules
- [specific rules that would prevent these failures]

### Suggested Skills
- [skills that would help handle these scenarios better]

### Statistics
- Total observations analyzed: N
- Most common failure tool: X
- Most common error type: Y

**IMPORTANT**: Suggest changes but do NOT modify rules directly. The user decides what to adopt.
