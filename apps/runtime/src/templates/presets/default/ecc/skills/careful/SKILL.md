---
name: careful
description: On-demand safety gate that blocks destructive commands. Activate with /learn careful when working on production systems or sensitive data.
---

# Careful Mode

When this skill is loaded, treat ALL of the following as BLOCKED unless the user explicitly confirms:

## Blocked commands (require explicit user approval)
- `rm -rf` or `rm -r` on any directory
- `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`
- `git push --force`, `git push -f`
- `git reset --hard`
- `docker rm`, `docker rmi`, `docker system prune`
- `kubectl delete`
- Any command with `--no-verify` or `--skip-hooks`

## Blocked operations
- Deleting files outside the current project directory
- Overwriting .env or credentials files
- Modifying CI/CD pipeline configs without showing diff first

## How to handle
When you encounter a blocked operation:
1. STOP — do not execute
2. Show the user exactly what you were about to do
3. Ask for explicit confirmation: "This is a destructive operation. Proceed? (yes/no)"
4. Only proceed if user says yes

## Deactivation
This skill stays active until the session ends or the user says "disable careful mode".
