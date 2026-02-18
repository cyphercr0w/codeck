# AGENTS.md — Codeck Agent Instructions

**This file is the single source of truth for agent behavior in this workspace.**
Read this file FIRST at the start of every session, before reading any other file.

---

## Memory System

Your memory lives in `/workspace/.codeck/memory/`. This is persistent, file-based, and survives between sessions.

### Layout

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
  sessions/                 # PTY session transcripts (JSONL, auto-captured)
  index/                    # SQLite FTS5 index (auto-maintained, ephemeral)
  state/                    # paths.json, flush_state.json
  AGENTS.md                 # THIS FILE
  preferences.md            # User preferences
  rules/                    # Coding, communication, workflow rules
  skills/                   # Reusable workflow templates
```

### Memory rules — MANDATORY

1. **Search before asking.** Before asking the user a question that may have been answered before, search memory: `GET /api/memory/search?q=<topic>`. If you find relevant context, use it. Do not waste the user's time re-asking.

2. **Write daily entries.** During work, periodically write progress to today's daily entry:
   - Use `POST /api/memory/daily` with `{ entry, project, tags }`
   - Format: concise, scannable, with file paths and function names
   - Write every ~15 messages in long conversations
   - ALWAYS write before ending a session or switching tasks

3. **Use durable memory.** Read `/workspace/.codeck/memory/MEMORY.md` at session start. This contains curated, important information that survived triage. Trust it.

4. **Path-scoped memory.** When working on a specific project (path), use path-scoped memory:
   - Resolve the path: `POST /api/memory/paths/resolve` with `{ canonicalPath }`
   - Read path memory: `GET /api/memory/paths/<pathId>`
   - The path's MEMORY.md has architecture, patterns, current state, decisions

5. **Never auto-promote.** Promotion from daily to durable memory is explicit, human-initiated. You do NOT promote content automatically. You may suggest promotion to the user.

6. **Record decisions.** When you make a significant architectural or technical decision, create an ADR:
   - `POST /api/memory/decisions/create` with `{ title, context, decision, consequences }`
   - Naming: `ADR-YYYYMMDD-slug.md`

7. **Never write secrets.** Do not log API keys, tokens, passwords, or credentials to any memory file. If you encounter a secret in output, omit it.

### Search

The memory system has full-text search powered by SQLite FTS5 (BM25 ranking):

```
GET /api/memory/search?q=<query>&scope=durable,daily,decision,path,session&limit=20
```

- Scopes: `durable`, `daily`, `decision`, `path`, `path-daily`, `session`
- Results include highlighted snippets
- Search is available only in the Docker container (not local dev)

### Flush

When context is getting long and you risk losing information:

```
POST /api/memory/flush
{ "content": "summary of current state...", "scope": "global", "tags": ["context-save"] }
```

Rate-limited to once per 30 seconds per scope.

### Context recovery

After compaction or at session start:

```
GET /api/memory/context?pathId=<pathId>
```

Returns concatenated: global MEMORY.md + today's daily + path memory + path daily.

---

## Startup sequence

Every session, in this order:

1. Read THIS file (`/workspace/.codeck/AGENTS.md`)
2. Read preferences (`/workspace/.codeck/preferences.md`)
3. Read rules (`/workspace/.codeck/rules/`)
4. Read global memory (`/workspace/.codeck/memory/MEMORY.md`)
5. If working on a project: resolve path, read path memory
6. If no path memory exists: explore the codebase, create path memory before doing work
7. Check skills (`/workspace/.codeck/skills/`) for reusable workflows

---

## Session end sequence

Before ending ANY session:

1. Write final daily entry with: what was done, current state, next steps
2. Update path-scoped MEMORY.md with current state and decisions
3. If architectural decisions were made: create ADR(s)
4. If user preferences were discovered: update preferences.md

These steps are **mandatory**. Not optional. Not "if significant". EVERY session.

---

## Self-Development (systemd mode)

When running on a VPS (systemd mode), you can develop Codeck itself. The workspace contains a full clone of the Codeck repo at `/workspace/codeck`.

### How it works

- **`/opt/codeck`** — the LIVE installation (systemd runs from here)
- **`/workspace/codeck`** — your dev clone (edit, build, test here)

### Workflow

1. Work in `/workspace/codeck` — edit code, run tests
2. `git add`, `git commit`, `git push` your changes
3. Run `bash /workspace/codeck/scripts/self-deploy.sh` to deploy
4. The script builds, syncs to `/opt/codeck`, and restarts the service
5. Your terminal session will die (the service restarted). The frontend auto-reconnects.

### Important

- **Always commit before deploying.** The service restart kills your session — uncommitted work in progress is fine (it stays on disk), but committed code is safer.
- **Quick deploy** (skip npm ci): `bash /workspace/codeck/scripts/self-deploy.sh --quick`
- **If deploy breaks the server**, SSH in and rollback: `cd /opt/codeck && sudo git checkout . && sudo systemctl restart codeck`
- You have sudo access for: `systemctl restart/stop/start codeck`, `rsync`, `cp`, `chown`
