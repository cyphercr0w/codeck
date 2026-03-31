<p align="center">
  <h1 align="center">Codeck</h1>
</p>

<p align="center">
  <strong>Your own cloud machine for Claude Code — with persistent memory.</strong>
</p>

<p align="center">
  <a href="https://github.com/cyphercr0w/codeck/releases"><img src="https://img.shields.io/github/v/release/cyphercr0w/codeck?style=flat-square" alt="Release"></a>
  <a href="https://github.com/cyphercr0w/codeck/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cyphercr0w/codeck?style=flat-square" alt="AGPL-3.0"></a>
  <a href="https://github.com/cyphercr0w/codeck/stargazers"><img src="https://img.shields.io/github/stars/cyphercr0w/codeck?style=flat-square" alt="Stars"></a>
  <a href="https://ghcr.io/cyphercr0w/codeck"><img src="https://img.shields.io/badge/docker-ghcr.io-blue?style=flat-square&logo=docker" alt="Docker"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="docs/README.md">Docs</a>
</p>

---

<!-- TODO: Record 15s demo GIF -->
<!-- Show: open browser -> Claude Code terminal -> memory recall -> multi-terminal -->
<!-- Host via GitHub CDN (drag into issue, copy URL) — do NOT commit large GIFs to repo -->

Codeck gives Claude Code its own always-on machine. Persistent workspace, memory that survives across sessions, full terminal access — accessible from any browser on any device. Self-hosted. You bring your own Anthropic account.

## Why Codeck

Every time you start Claude Code, it forgets everything. Your projects, your preferences, your context — gone. You rebuild from scratch, every session.

Codeck fixes that:

- **Always on.** A dedicated machine that never shuts down. Your projects, servers, and files persist between sessions.
- **Memory across sessions.** Claude remembers who you are, what you're building, and decisions you've made — automatically.
- **Access from anywhere.** Browser-based. Phone, tablet, laptop — same workspace, same agent.

## Features

**For the agent**

- Up to 5 concurrent PTY terminals (node-pty + xterm.js)
- Persistent memory — FTS5 search, per-project context, daily journals, durable global memory
- Scheduled agents — recurring tasks, cron-style, without you present
- Full environment: git, GitHub CLI, Docker, internet access

**For you**

- Browser UI from any device (phones, tablets, laptops)
- Claude OAuth PKCE — automatic token refresh, zero manual re-auth
- Password authentication — scrypt-hashed, 7-day sessions
- File browser with inline editor
- GitHub integration — SSH keys + CLI device flow
- Dashboard — CPU, memory, disk, session count, API usage
- LAN access — `codeck.local` via mDNS from any device
- Workspace export as `.tar.gz`

## Quick Start

Pull the image and run. No build step required.

```bash
docker pull ghcr.io/cyphercr0w/codeck:latest

docker run -d --name codeck \
  -p 80:80 \
  -v codeck-workspace:/workspace \
  -v codeck-claude:/root/.claude \
  --restart unless-stopped \
  ghcr.io/cyphercr0w/codeck:latest --web
```

Open `http://localhost` in your browser. Sign in with your Anthropic account. Done.

> **VPS install** (one-liner):
> ```bash
> curl -fsSL https://codeck.xyz/install | bash
> ```

## How It Works

Codeck runs inside a Docker container with full tool access. The web app serves a browser-based terminal connected to real PTY sessions running Claude Code. OAuth PKCE handles authentication — your Anthropic credentials never touch our servers.

The memory system (SQLite FTS5) indexes per-project context, daily journals, and durable global memory. Claude reads this automatically at session start — no manual context-loading required.

```
Browser --> Web App (Preact + xterm.js) --> WebSocket --> PTY (node-pty) --> Claude Code CLI
                                                             |
                                                       Memory System (SQLite FTS5)
                                                             |
                                                   /workspace/.codeck/memory/
```

## Documentation

Full technical reference in [`docs/`](docs/README.md):

| Doc | Covers |
|-----|--------|
| [Architecture](docs/ARCHITECTURE.md) | System design, auth flows, security model |
| [API](docs/API.md) | REST endpoints and WebSocket protocol |
| [Services](docs/SERVICES.md) | Backend service layer internals |
| [Frontend](docs/FRONTEND.md) | Preact SPA, components, signals, CSS |
| [Configuration](docs/CONFIGURATION.md) | Env vars, Docker, volumes, presets |
| [Deployment](docs/DEPLOYMENT.md) | systemd install, VPS setup, troubleshooting |
| [Known Issues](docs/KNOWN-ISSUES.md) | Bugs, tech debt, planned improvements |

## Contributing

Contributions are welcome. To develop Codeck from inside a running instance:

```bash
curl -fsSL https://raw.githubusercontent.com/cyphercr0w/codeck/main/scripts/dev-setup.sh | sudo bash
```

After changes: `npm run build && sudo systemctl restart codeck`

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full development workflow.

## License

[AGPL-3.0](LICENSE)
