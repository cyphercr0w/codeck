# Codeck

**Freedom for the agent.**

A persistent environment for Claude Code — always-on workspace, memory across sessions, full tool access, accessible from any browser.

Give the agent its own machine. Let it live there.


## Deploy

### Quick start — pre-built image

Pull the image directly from GitHub Container Registry. No build step required.

```bash
docker pull ghcr.io/cyphercr0w/codeck:latest
docker run -d --name codeck \
  -p 80:80 \
  -v codeck-workspace:/workspace \
  -v codeck-claude:/root/.claude \
  --restart unless-stopped \
  ghcr.io/cyphercr0w/codeck:latest --web
```

Then open `http://localhost` in your browser. That's it.

### Isolated mode — single container

Runs inside a Docker container. No daemon, no Docker socket. Safe for local use on any platform.

```bash
git clone https://github.com/cyphercr0w/codeck
cd codeck && npm install && npm run build:cli
codeck init        # interactive setup wizard — choose "Isolated"
codeck start       # → http://localhost
codeck stop
codeck status
codeck logs
codeck open
codeck restart
codeck doctor      # diagnose configuration issues
```

Or with npm workspace: `npx -w @codeck/cli codeck init`. Link globally with `npm link -w @codeck/cli`.

### Managed mode — daemon + container

Daemon on host handles auth, webapp, and port exposure. Runtime in isolated container. Works on Linux, macOS, and Windows.

```bash
codeck init        # choose "Managed"
codeck start       # starts runtime container + daemon in foreground (Ctrl+C to stop)
```

#### LAN access (macOS / Windows)

```bash
codeck lan start   # start mDNS advertiser — codeck.local resolves on all LAN devices
codeck lan stop    # stop advertiser and clean up hosts file
codeck lan status  # check if advertiser is running
```

On Linux, LAN access uses host networking — configure via `codeck init` instead.

### Linux VPS — systemd service

For production VPS, the managed mode daemon runs as a systemd service:

```bash
curl -fsSL https://raw.githubusercontent.com/cyphercr0w/codeck/main/scripts/install.sh | sudo bash
```

Installs Node.js, Docker, builds images, creates a `codeck` user, and starts the service on port 80.

```bash
systemctl status codeck
journalctl -u codeck -f
```



## What you get

**For the agent**
- Up to 5 concurrent PTY terminals (node-pty + xterm.js)
- Persistent memory — FTS5 search, per-project MEMORY.md, daily journals, durable global context
- Proactive agents — schedule recurring tasks (cron-style)
- Full environment: git, GitHub CLI, Docker, internet

**For you**
- Browser UI — works from phones, tablets, anywhere
- Claude OAuth PKCE — automatic token refresh, no manual re-auth
- Password auth — scrypt-hashed, 7-day sessions
- File browser with inline editor
- GitHub integration — SSH keys + CLI device flow
- Dashboard — CPU, memory, disk, session count, API usage
- LAN access — `codeck.local` from any device via mDNS
- Workspace export as `.tar.gz`


## Contributing

To develop Codeck from inside a running Codeck instance, use `dev-setup.sh`. It clones the repo to `/opt/codeck` and symlinks it into the workspace so it's editable from inside the sandbox.

```bash
curl -fsSL https://raw.githubusercontent.com/cyphercr0w/codeck/main/scripts/dev-setup.sh | sudo bash
```

After changes: `npm run build && sudo systemctl restart codeck`



## Documentation

[`docs/`](docs/README.md) — full technical reference:

| Doc | Covers |
|-----|--------|
| [Architecture](docs/ARCHITECTURE.md) | System design, auth flows, security model |
| [API](docs/API.md) | REST endpoints and WebSocket protocol |
| [Services](docs/SERVICES.md) | Backend service layer internals |
| [Frontend](docs/FRONTEND.md) | Preact SPA, components, signals, CSS |
| [Configuration](docs/CONFIGURATION.md) | Env vars, Docker, volumes, presets |
| [Deployment](docs/DEPLOYMENT.md) | systemd install, VPS setup, troubleshooting |
| [Known Issues](docs/KNOWN-ISSUES.md) | Bugs, tech debt, planned improvements |
