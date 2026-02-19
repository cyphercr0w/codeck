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

## Session shutdown (every time, no exceptions)
1. Update the project doc with current state, what you did, next steps
2. Update `/workspace/.codeck/memory/summary.md` with a brief entry
3. If you made an architectural decision, append to decisions.md

## Why this matters
These memory files are shared across sessions and across agents. If you skip updates, the next session (or a different agent working on the same project) starts blind. Your documentation is someone else's head start.
