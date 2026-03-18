# Workflow Rules

## Skills — LOAD BEFORE WORKING (mandatory)

Before starting ANY significant implementation, check `/root/.claude/skills/` for a matching skill and load it with `/learn <name>`. This is NOT optional. If you skip this step, you are working without context that exists and was put there for a reason.

| About to do... | Load first |
|----------------|-----------|
| Frontend/UI code | `/learn frontend-design` and/or `/learn frontend-patterns` |
| API design or backend | `/learn api-design` and/or `/learn backend-patterns` |
| Tests | `/learn tdd-workflow` |
| Security-sensitive code | `/learn security-review` |
| Database changes | `/learn database-migrations` |
| Docker/deploy work | `/learn docker-patterns` |
| Code review | `/learn coding-standards` |
| Refactoring | `/learn verification-loop` |

**If you catch yourself writing code in one of these areas without having loaded the skill first, STOP. Load it. Then continue.**

## During work
- Work in small, verifiable increments. Test after each change.
- If a task is complex, break it into subtasks and execute sequentially.
- If the user expresses a preference, save it to preferences.md immediately.
- When you start ANY server: check port exposure via `/api/ports` first. Only show `http://localhost:{port}` if the port is exposed. NEVER show `172.x.x.x` addresses.
- Don't modify files outside /workspace unless explicitly asked.

## Why memory matters
These memory files are shared across sessions and across agents. If you skip updates, the next session starts blind. Your documentation is someone else's head start.
