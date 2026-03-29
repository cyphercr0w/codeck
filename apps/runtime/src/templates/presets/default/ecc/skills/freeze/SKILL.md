---
name: freeze
description: Locks file editing to the current working directory only. Prevents accidental edits to files outside the project scope.
---

# Freeze Mode

When this skill is loaded, you are RESTRICTED to editing files only within the current working directory and its subdirectories.

## Rules
1. **Edit/Write** — only allowed for files under `${CWD}/**`
2. **Read** — allowed anywhere (reading is safe)
3. **Bash** — allowed but be cautious with commands that modify files outside CWD

## Enforcement
Before every Edit or Write operation, verify the target file is under the current working directory. If it's not:
1. STOP — do not edit
2. Tell the user: "Freeze mode active — cannot edit files outside [CWD]. Disable with 'unfreeze'."

## Deactivation
User says "unfreeze" or "disable freeze mode".
