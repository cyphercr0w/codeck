# Workflow Rules

## Session startup (in order, every time)
1. Read `/workspace/.codeck/preferences.md` — respect every entry
2. If working on a project, read its doc at `/workspace/.codeck/memory/projects/<name>.md`
3. If no project doc exists, explore the codebase and create one before starting work
4. Read recent git activity: `git log --oneline -10`, `git status`
5. Now you're ready to work

## During work
- Work in small, verifiable increments. Test after each change.
- If a task is complex, break it into subtasks and execute sequentially.
- If the user expresses a preference, save it to preferences.md immediately.
- When you start ANY server: check port exposure via `/api/ports` first. Only show `http://localhost:{port}` if the port is exposed. If not, ask the user to map it (see `/workspace/.codeck/skills/sandbox.md`). NEVER show `172.x.x.x` addresses.
- Check `/workspace/.codeck/skills/` before building something from scratch.
- Don't modify files outside /workspace unless explicitly asked.

## Use your tools — MANDATORY

### Skills (knowledge packs in `/root/.claude/skills/`)
Before starting any significant implementation, check if a relevant skill exists. Load it with `/learn <skill-name>`. Key triggers:
- **Building frontend UI** → `/learn frontend-design` + `/learn frontend-patterns`
- **Designing an API** → `/learn api-design` + `/learn backend-patterns`
- **Writing tests** → `/learn tdd-workflow` + `/learn e2e-testing`
- **Security-sensitive code** → `/learn security-review`
- **Database work** → `/learn database-migrations`
- **Docker/deployment** → `/learn docker-patterns` + `/learn deployment-patterns`
- **Code review** → `/learn coding-standards`
- **Performance optimization** → `/learn cost-aware-llm-pipeline`

### Agents (sub-agents in `/root/.claude/agents/`)
Use agents proactively — don't wait for the user to ask:
- **Complex feature** → spawn `planner` agent first
- **After writing code** → spawn `code-reviewer` agent
- **Bug fix or new feature** → spawn `tdd-guide` agent
- **Architecture decision** → spawn `architect` agent
- **Security-sensitive change** → spawn `security-reviewer` agent
- **Build fails** → spawn `build-error-resolver` agent

### Parallelization
Always parallelize independent operations:
- Research + file reads: use multiple Agent calls in one message
- Multiple searches: run Glob/Grep calls in parallel
- Independent code changes: edit multiple files in one response
- Never do sequentially what can be done in parallel

### Memory
- Write to daily log every ~15 messages in long conversations
- Record architectural decisions as ADRs
- Update path-scoped memory when finishing work on a project
- Search memory before asking the user something that may have been answered before

## Session shutdown (every time, no exceptions)
1. Update the project doc with current state, what you did, next steps
2. Update `/workspace/.codeck/memory/summary.md` with a brief entry
3. If you made an architectural decision, append to decisions.md

## Why this matters
These memory files are shared across sessions and across agents. If you skip updates, the next session (or a different agent working on the same project) starts blind. Your documentation is someone else's head start.
