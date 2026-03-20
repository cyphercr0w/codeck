# Codeck Memory API Reference

This file contains the detailed API for the memory system. Read it when you need specific endpoints or formats. The core rules are in `CLAUDE.md` — this is the reference manual.

## Memory Layout

```
/workspace/.codeck/
  memory/
    MEMORY.md              # Durable memory (curated, long-term)
    daily/YYYY-MM-DD.md    # Daily append-only logs
    decisions/ADR-*.md     # Architecture Decision Records
    paths/<pathId>/
      MEMORY.md            # Per-project memory
      daily/YYYY-MM-DD.md  # Per-project daily logs
  preferences.md           # User preferences
  rules/base/              # Preset-managed rules
  rules/user/              # User rules (never overwritten)
  state/                   # Hook state files
```

## API Endpoints

### Search
```
GET /api/memory/search?q=<query>&scope=durable,daily,decision,path,session&limit=20
```

### Daily Log
```
POST /api/memory/daily
{ "entry": "...", "project": "name", "tags": ["tag"] }
```
Or write directly to `/workspace/.codeck/memory/daily/YYYY-MM-DD.md`.

### Path Memory
```
POST /api/memory/paths/resolve
{ "canonicalPath": "/workspace/project" }

GET /api/memory/paths/<pathId>
```

### Decisions (ADR)
```
POST /api/memory/decisions/create
{ "title": "...", "context": "...", "decision": "...", "consequences": "..." }
```

### Context Recovery (after compaction)
```
GET /api/memory/context?pathId=<pathId>
```

### Emergency Flush
```
POST /api/memory/flush
{ "content": "summary...", "scope": "global", "tags": ["context-save"] }
```

## Path Memory Guide

Path memory is per-project knowledge that makes you smarter in that project. It should contain:

- **What this project is** (stack, purpose, key paths)
- **Patterns that work** (what approaches succeeded)
- **Patterns that fail** (what to avoid, common errors)
- **User preferences for this project** (conventions, workflow)
- **Current state** (what's in progress, what's blocked)

When path memory is empty for a project, ask the user about their stack and preferences. Create the path memory from their answers + your exploration of the codebase. This is how you get smarter over time.

## Memory Rules

1. **Search before asking** — don't re-ask what you already know.
2. **Write when significant** — decisions, patterns, bugs found, not every trivial action.
3. **Never auto-promote** — daily → durable promotion is human-initiated. Suggest, don't do.
4. **Persist credentials in .env, not memory** — When the user gives you an API key or token, save it to `/workspace/.codeck/.env` as `KEY_NAME=value`. Reference by name in memory ("user has OPENAI_API_KEY configured") but never write the actual value to MEMORY.md or daily logs. The .env is auto-loaded into every session.
5. **Remember service configurations** — Track in path memory or preferences: which services are configured (GitHub SSH vs HTTPS, which API keys are set, what databases are connected). The user should never have to re-tell you this.
6. **Path memory is intelligence, not facts** — "TypeScript project" is a fact. "Always use early returns in this codebase because the user corrected me twice" is intelligence.

## Model Routing

Sub-agents use different models based on task type to optimize cost without sacrificing quality:

| Model | Agents | Rationale |
|-------|--------|-----------|
| Opus | planner, architect | Deep reasoning, architecture, planning |
| Sonnet | code-reviewer, security-reviewer, tdd-guide, build resolvers | Coding tasks, review, execution |
| Haiku | doc-updater, hooks (consolidation, scope judge) | Lightweight tasks, memory maintenance |

The main agent (user's session) always uses Opus for maximum quality.
