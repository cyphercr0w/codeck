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

## Dev Commands

```bash
# Build base image (once):
docker build -t codeck-base -f docker/Dockerfile.base .

# Dev:
docker compose -f docker/compose.yml -f docker/compose.dev.yml up --build

# Prod:
docker compose -f docker/compose.yml up

# Prod with LAN access (codeck.local from any device):
docker compose -f docker/compose.yml -f docker/compose.lan.yml up

# Local build check:
npm run build

# CLI (workspace package in apps/cli/):
npm run build:cli   # from project root

# Gateway mode (daemon + runtime in separate containers):
docker compose -f docker/compose.gateway.yml up --build

# Hosted mode (daemon on host + runtime in container, for VPS):
docker compose -f docker/compose.hosted.yml up -d
```

## LAN Access

Run the host-side mDNS advertiser for LAN device discovery (works on all platforms):

```powershell
# One-time setup:
cd scripts && npm install

# Run (requires admin for hosts file management):
node scripts/mdns-advertiser.cjs
```

This makes `codeck.local` and `{port}.codeck.local` resolvable from phones, tablets, and other LAN devices. See `docs/CONFIGURATION.md` for details.

## Conventions

- **Language**: all English — code, comments, commits, PRs
- **Commits**: Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`)
- **Branching**: work directly on `main`
- **Code style**: follow existing patterns in the codebase (no reformatting unrelated code)

## Self-Deploy (VPS / systemd mode)

If you are running on a VPS where this repo IS the live Codeck installation (`/opt/codeck`), you can deploy your own changes:

```bash
# After editing code:
npm run build && docker build -t codeck -f docker/Dockerfile . && sudo systemctl restart codeck
```

Or use the helper script: `bash scripts/self-deploy.sh`

**Important:**
- The service restart kills your terminal session. The frontend auto-reconnects.
- `systemctl restart codeck` manages both the daemon and the runtime container.
- Always `git commit` before deploying — your files stay on disk, but committed code is safer.
- If a deploy breaks the server, SSH in: `sudo git checkout . && sudo npm run build && docker build -t codeck -f docker/Dockerfile . && sudo systemctl restart codeck`
- You have sudo for: `systemctl restart/stop/start codeck`

## Rules

- **Always update docs after any change.** README.md, docs/, and CLAUDE.md must reflect the current state. Update them in the same commit as the code change — never leave docs stale.
- Always kill existing servers before starting new ones (`netstat -ano | findstr ":8080"`)
