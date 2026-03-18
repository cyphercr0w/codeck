# Workflow

## Skill Loading

Before editing code in a specialized area, load the matching skill. The skill-reminder hook will block your first edit if you haven't.

| Area | Skill |
|------|-------|
| Frontend/UI | `frontend-design`, `frontend-patterns` |
| API/backend | `api-design`, `backend-patterns` |
| Tests | `tdd-workflow` |
| Security | `security-review` |
| Database | `database-migrations` |
| Docker/deploy | `docker-patterns` |
| Refactoring | `verification-loop` |

## Sub-Agent Delegation

Don't do everything yourself. Delegate:
- **Complex task** → `planner` agent first
- **After code changes** → `code-reviewer` agent (mandatory)
- **Research/exploration** → `Explore` agent (keeps your context clean)
- **Architecture decision** → `architect` agent

## Work Style

- Small, verifiable increments. Build/test after each change.
- Complex task → break into subtasks, execute sequentially.
- Detect user preferences → save to `preferences.md` silently.
