# Codeck Documentation

Technical documentation for Codeck — a Docker sandbox that runs Claude Code with persistent memory, terminal access via browser, and one-click integrations.

## Architecture

Codeck runs as a **single Docker container**. No daemon, no CLI tool, no multi-container orchestration. The container runs an Express server that serves the web UI, manages PTY terminals, handles auth, and provides APIs for everything.

```
Browser → nginx (optional SSL) → Container :80
                                   ├── Express (API + static files)
                                   ├── WebSocket (terminal I/O, status)
                                   ├── node-pty (Claude Code sessions)
                                   └── Volumes (workspace, config, ssh)
```

## Contents

| Document | What it covers |
|----------|---------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, auth flows, PTY lifecycle, WebSocket protocol, preset system, security model |
| [API.md](API.md) | REST endpoints and WebSocket messages with request/response formats |
| [SERVICES.md](SERVICES.md) | Backend services: auth, console, memory, git, agents, permissions |
| [FRONTEND.md](FRONTEND.md) | Preact SPA: components, signals state, terminal, toast system |
| [CONFIGURATION.md](CONFIGURATION.md) | Docker config, env vars, volumes, presets, MCP servers |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Install on VPS, update flow, resource allocation, reverse proxy |
| [PROACTIVE-AGENTS.md](PROACTIVE-AGENTS.md) | Scheduled background agents (cron-like) |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | Technical debt and pending improvements |

## Quick Reference

```bash
# Install
curl -fsSL https://codeck.xyz/install | bash

# Manual Docker run
docker run -d --name codeck -p 8080:80 \
  -v codeck-workspace:/workspace \
  -v codeck-claude:/root/.claude \
  -v codeck-ssh:/root/.ssh \
  -v codeck-gh:/root/.config/gh \
  -v codeck-data:/data/.codeck \
  --restart unless-stopped \
  ghcr.io/cyphercr0w/codeck:latest --web

# Update
docker pull ghcr.io/cyphercr0w/codeck:latest
docker stop codeck && docker rm codeck
# Re-run the docker run command above (volumes persist)

# Dev (from source)
npm run docker:build-base   # once
npm run docker:rebuild      # build + start
npm run docker:up            # start
npm run docker:down          # stop
npm run docker:logs          # tail logs
npm test                     # 621 tests
```
