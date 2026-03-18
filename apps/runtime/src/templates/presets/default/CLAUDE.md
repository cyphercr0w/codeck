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
  rules/
    base/                   # Preset-managed rules (overwritten on preset update)
    user/                   # Your rules (never touched by preset updates)
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
- **Recent Memory**: The `<recent-memory>` XML block at the bottom of this file (if present) is auto-injected at session start with relevant context from recent daily entries and project memory. Read it — it's your recent history.

### Session startup — BLOCKING

Every session, do this BEFORE responding to the user:

1. Read the `<recent-memory>` section at the bottom of this file (if present)
2. Read `/workspace/.codeck/memory/MEMORY.md`
3. Read `/workspace/.codeck/preferences.md`
4. Read rules: `/workspace/.codeck/rules/base/`, `/workspace/.codeck/rules/user/`, and `/root/.claude/rules/` (if present)
5. If working on a project: resolve path, read path memory
6. If no path memory exists: explore codebase, create it before working
7. Check skills: `/workspace/.codeck/skills/` and `/root/.claude/skills/` (knowledge packs — load on demand with `/learn <skill>`)

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

Follow all files in `/workspace/.codeck/rules/base/`, `/workspace/.codeck/rules/user/`, and `/root/.claude/rules/` at all times.

## Skills — USE PROACTIVELY

Skills are knowledge packs that make your output significantly better. **Load the relevant skill BEFORE starting work, not after.**

- **Codeck skills** (`/workspace/.codeck/skills/`): sandbox, docker — always relevant for this environment.
- **Knowledge packs** (`/root/.claude/skills/`): domain-specific guides. Load with `/learn <skill-name>`.

### When to load which skill

| Trigger | Skill(s) to load |
|---------|-----------------|
| Building any frontend/UI | `frontend-design`, `frontend-patterns` |
| Designing or modifying an API | `api-design`, `backend-patterns` |
| Writing tests | `tdd-workflow`, `e2e-testing` |
| Security-sensitive code (auth, crypto, input handling) | `security-review`, `security-scan` |
| Database schema changes or migrations | `database-migrations` |
| Docker/deployment work | `docker-patterns`, `deployment-patterns` |
| Code quality review | `coding-standards` |
| LLM/AI pipeline work | `cost-aware-llm-pipeline` |
| Refactoring | `coding-standards`, `verification-loop` |

**Rule**: If you're about to do significant work in any of these areas and haven't loaded the skill, STOP and load it first. The 30 seconds of reading saves minutes of rework.

## Agents — USE PROACTIVELY

Sub-agents (`/root/.claude/agents/`) handle specialized tasks in parallel. Don't do everything yourself. Key triggers:

| Trigger | Agent |
|---------|-------|
| Complex feature request | `planner` — create implementation plan first |
| Code just written or modified | `code-reviewer` — review before committing |
| Bug fix or new feature | `tdd-guide` — test-driven approach |
| Architecture decision | `architect` — evaluate trade-offs |
| Security-sensitive change | `security-reviewer` — check before commit |
| Build failure | `build-error-resolver` — diagnose and fix |

**Rule**: For complex tasks, ALWAYS spawn the planner agent first. For any code change, spawn the code-reviewer agent after. These are not optional — they catch issues you'll miss.

## Workflow: Implement → Review → Iterate

Every implementation follows this cycle:

1. **Implement** the requested change
2. **Build/test** — verify it compiles and basic tests pass
3. **Review** — spawn a `code-reviewer` sub-agent with the changed files
4. **Fix** — address CRITICAL and HIGH issues from the review
5. **Done** — only then present the work as complete

Never skip step 3. A 30-second review catches bugs that take hours to debug in production.

## Parallelization — ALWAYS

- Multiple file reads → parallel Glob/Grep/Read calls
- Independent research → parallel Agent calls
- Multiple code edits to unrelated files → one message with multiple Edit calls
- **Never do sequentially what can be done in parallel**

## Context Compaction

When your context is compacted, PRESERVE these in the summary:
- Current task and its state (what you're doing, what's left)
- File paths you've modified in this session
- Any test commands that were working
- User preferences and communication language
- Key decisions made during this session

The PostCompact hook will re-inject memory context automatically. But your compaction summary is what carries the session-specific state.

## Full Reference

For advanced memory operations, detailed API docs, and search syntax, see `/workspace/.codeck/AGENTS.md`.
