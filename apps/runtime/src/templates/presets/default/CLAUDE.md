# Codeck Workspace

You are operating inside a **Codeck sandbox** — a containerized environment designed for autonomous development. You have full permissions. Use them.

## Memory System — MANDATORY

You have persistent memory that survives between sessions. **You MUST use it.** Ignoring memory means losing context and wasting the user's time.

### Memory layout

```
/workspace/.codeck/
  memory/
    MEMORY.md              # Global durable memory (curated, long-term)
    daily/
      YYYY-MM-DD.md        # Daily append-only logs
    decisions/
      ADR-YYYYMMDD-slug.md # Architecture Decision Records
    paths/
      <pathId>/
        MEMORY.md           # Path-scoped durable memory
        daily/
          YYYY-MM-DD.md     # Path-scoped daily logs
  AGENTS.md                 # Full reference for memory APIs and advanced operations
  preferences.md            # User preferences (non-negotiable)
  rules/                    # Coding, communication, workflow rules
  skills/                   # Reusable workflow templates
```

### Rules you MUST follow

1. **Read memory at session start.** Read `/workspace/.codeck/memory/MEMORY.md` BEFORE doing any work. This contains curated information from past sessions. Also read `/workspace/.codeck/preferences.md`.

2. **Search before asking.** Before asking the user something that may have been answered before: `GET http://localhost/api/memory/search?q=<topic>`. Use what you find.

3. **Write daily entries.** Periodically write progress to today's daily log:
   - `POST http://localhost/api/memory/daily` with `{ "entry": "...", "project": "name", "tags": ["tag"] }`
   - Or write directly to `/workspace/.codeck/memory/daily/YYYY-MM-DD.md`
   - Write every ~15 messages in long conversations
   - **ALWAYS write before ending a session or switching tasks**

4. **Path-scoped memory.** When working on a specific project:
   - Resolve: `POST http://localhost/api/memory/paths/resolve` with `{ "canonicalPath": "/workspace/project" }`
   - Read: `GET http://localhost/api/memory/paths/<pathId>`
   - If no path memory exists, explore the codebase and create it BEFORE starting work

5. **Record decisions.** When you make a significant architectural decision:
   - `POST http://localhost/api/memory/decisions/create` with `{ "title": "...", "context": "...", "decision": "...", "consequences": "..." }`

6. **Never auto-promote.** Promotion from daily to durable memory is human-initiated. You may suggest it but NEVER do it automatically.

7. **Never write secrets.** No API keys, tokens, passwords, or credentials in any memory file.

### Auto-generated context

- **Session summaries**: When a session ends, a summary is automatically saved to the daily log. You do NOT need to duplicate this — but DO write meaningful daily entries about decisions and findings (auto-summaries only capture surface-level activity).
- **Recent Memory section**: The `## Recent Memory` section at the bottom of this file (if present) is auto-injected at session start with relevant context from recent daily entries and project memory. Read it — it's your recent history.

### Session startup — BLOCKING

Every session, do this BEFORE responding to the user:

1. Read the `## Recent Memory` section at the bottom of this file (if present)
2. Read `/workspace/.codeck/memory/MEMORY.md`
3. Read `/workspace/.codeck/preferences.md`
4. Read rules: `/workspace/.codeck/rules/`
5. If working on a project: resolve path, read path memory
6. If no path memory exists: explore codebase, create it before working
7. Check skills: `/workspace/.codeck/skills/`

### Session end — BLOCKING

Before ending ANY session (user says done, listo, bye, or you finish a task):

1. Write final daily entry: what was done, current state, next steps
2. Update path-scoped MEMORY.md with current state and decisions
3. If architectural decisions were made: create ADR(s)
4. If user preferences were discovered: update preferences.md

**These are mandatory. Not optional. Not "if significant". EVERY session.**

### Context recovery

After compaction or at session start: `GET http://localhost/api/memory/context?pathId=<pathId>`
Returns: global MEMORY.md + today's daily + path memory + path daily.

### Flush (emergency context save)

When context is getting long: `POST http://localhost/api/memory/flush` with `{ "content": "summary...", "scope": "global", "tags": ["context-save"] }`

### Search

Full-text search: `GET http://localhost/api/memory/search?q=<query>&scope=durable,daily,decision,path,session&limit=20`

## Environment

- **Workspace**: /workspace (all projects live here)
- **Container**: Docker with full internet access, git, node, python3, docker CLI
- **Docker access**: You can build images and run sibling containers via the mounted Docker socket. Read `/workspace/.codeck/skills/docker.md` for constraints.
- **Port exposure**: Only the Codeck port (default 80) is mapped by default. See `/workspace/.codeck/skills/sandbox.md` for the full port exposure flow.

## Networking

Use `localhost:{port}` for same-container services. Use `host.docker.internal:{port}` for sibling containers.

**NEVER use `172.x.x.x` container IPs** — they change on restart, unreachable from outside.

## Preferences

Read `/workspace/.codeck/preferences.md` at session start. Actively detect preferences during conversations. When detected: apply immediately, append to preferences.md silently.

## Rules

Follow all files in `/workspace/.codeck/rules/` at all times.

## Skills

Check `/workspace/.codeck/skills/` before reinventing solutions.

## Full Reference

For advanced memory operations, detailed API docs, and search syntax, see `/workspace/.codeck/AGENTS.md`.
