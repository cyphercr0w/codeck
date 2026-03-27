# Codeck

Docker sandbox that runs Claude Code CLI, accessible via a web app on port 80. OAuth PKCE for Claude auth, PTY terminals, mDNS LAN access.

## Documentation — READ FIRST, CODE SECOND

The `docs/` folder is the **single source of truth** for how this project works. Full index at [`docs/README.md`](docs/README.md).

The docs explain architecture, data flows, APIs, and conventions that you won't get from scanning code alone. Get context here first — only dive into source once you understand the subsystem from its doc. **After any change, update the corresponding doc in the same commit.** The docs only work as a context source if they stay current.

| Subsystem | Doc | Covers |
|-----------|-----|--------|
| Architecture | `docs/ARCHITECTURE.md` | Process lifecycle, auth flows, security model, container layout, PTY/tunnel design |
| API | `docs/API.md` | REST endpoints, request/response formats, WebSocket messages |
| Services | `docs/SERVICES.md` | Service exports, state shape, internal flows (`services/*.ts`) |
| Frontend | `docs/FRONTEND.md` | Components, signals, views, terminal, CSS (`src/web/`) |
| Config | `docs/CONFIGURATION.md` | Env vars, Dockerfile, compose, volumes, presets, keyring |
| Deployment | `docs/DEPLOYMENT.md` | Systemd install, VPS setup, service management, troubleshooting |
| Known Issues | `docs/KNOWN-ISSUES.md` | Bugs, tech debt, improvements |

## Key Architecture Decisions

- All Codeck data lives in `/workspace/.codeck/` — single location, agent-accessible without permission prompts
- System config (auth.json, config.json) and agent data (memory, rules, skills, preferences) share this location
- Preset manifests use absolute paths to drive file placement
- Three CLAUDE.md layers: global (`/root/.claude/`), workspace (`/workspace/`), project (`/workspace/<project>/`)
- Agent Teams (experimental): native Claude Code multi-agent coordination via tmux panes, replacing custom peer system. Templates at `/workspace/.codeck/teams/templates/`, API at `/api/teams`.

## Quick Start (Self-Hosted)

```bash
# Install on any Linux VPS:
curl -fsSL https://codeck.xyz/install | bash

# Or manually with Docker:
docker run -d --name codeck -p 8080:80 \
  -v codeck-workspace:/workspace \
  -v codeck-claude:/root/.claude \
  --restart unless-stopped \
  ghcr.io/cyphercr0w/codeck:latest --web
```

## Dev Commands

```bash
# Build base image (once):
npm run docker:build-base

# Build app + run locally:
npm run docker:rebuild

# Build check (no Docker):
npm run build

# Start / stop / logs:
npm run docker:up
npm run docker:down
npm run docker:logs
```

## Conventions

- **Language**: all English — code, comments, commits, PRs
- **Commits**: Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`)
- **Branching**: work directly on `main`
- **Code style**: follow existing patterns in the codebase (no reformatting unrelated code)

## Rules

- **Always update docs after any change.** README.md, docs/, and CLAUDE.md must reflect the current state. Update them in the same commit as the code change — never leave docs stale.
- Always kill existing servers before starting new ones
