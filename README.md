# Codeck

**Freedom for the agent.** Codeck gives Claude Code its own persistent environment — a dedicated workspace with memory, tools, and full autonomy. Access it from any browser.

Run it as a Docker container on your laptop, or deploy it as a systemd service on a dedicated VPS and let the agent live there full-time.

---

## Deployment options

### VPS / Dedicated server (recommended)

The agent gets its own machine. Persistent memory, background tasks, always-on.

```bash
# Fresh VPS — installs everything and starts the service
curl -fsSL https://raw.githubusercontent.com/cyphercr0w/codeck/main/scripts/dev-setup.sh | sudo bash
```

After setup, open `http://<your-server-ip>` in the browser.

```bash
# Service management
systemctl status codeck
journalctl -u codeck -f
npm run build && sudo systemctl restart codeck   # deploy code changes
```

### Docker (local or cloud)

```bash
# 1. Build base image (once, ~5 min)
docker build -t codeck-base -f Dockerfile.base .

# 2. Start
docker compose up

# 3. Open http://localhost
```

### CLI (Docker lifecycle manager)

```bash
cd cli && npm install && npm run build && npm link

codeck init      # interactive setup wizard
codeck start     # start container
codeck open      # open in browser
codeck status    # show URLs and config
codeck logs      # stream logs
```

---

## What it gives the agent

- **Persistent workspace** — projects and memory survive restarts
- **Full tool access** — terminal, git, GitHub CLI, Docker, internet
- **Memory system** — SQLite FTS5 search, per-project context, daily journals, durable memory across sessions
- **Up to 5 concurrent PTY terminals** — via node-pty + xterm.js + WebSocket
- **Proactive agents** — schedule recurring tasks (cron-style)
- **File browser** — view and edit workspace files from the browser
- **GitHub integration** — SSH keys + CLI device flow authentication
- **Port preview** — dev servers inside the environment accessible via browser

## What it gives you

- **Browser UI** — access from anywhere, including phones and tablets
- **Claude OAuth** — PKCE auth flow, automatic token refresh
- **Local password** — scrypt-hashed, 7-day session tokens
- **LAN access** — `codeck.local` from any device on your network via mDNS
- **Dashboard** — CPU, memory, disk, active sessions, Claude API usage
- **Preset system** — manifest-driven workspace configuration

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Codeck (Docker container or VPS systemd service)    │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  Express Server (:80 or :8080)                 │  │
│  │  ├── REST API (/api/*)                         │  │
│  │  ├── WebSocket (terminal I/O + logs)           │  │
│  │  └── Static files (Vite build)                 │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Claude   │  │ node-pty │  │ Memory system     │  │
│  │ Code CLI │  │ sessions │  │ (SQLite FTS5)     │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│                                                      │
│  /workspace/   /workspace/.codeck/   ~/.claude/      │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│  Browser (Preact + xterm.js)                         │
│  ├── Auth (password + OAuth + preset wizard)         │
│  ├── Home (account, resources, usage dashboard)      │
│  ├── Files (file browser + editor)                   │
│  ├── Claude (PTY terminals, up to 5 sessions)        │
│  ├── Agents (proactive / scheduled tasks)            │
│  ├── Integrations (GitHub SSH + CLI device flow)     │
│  ├── Memory (workspace .codeck/ viewer/editor)       │
│  └── Settings (password, sessions, auth log)         │
└──────────────────────────────────────────────────────┘
```

---

## LAN access (`codeck.local`)

```bash
# With CLI
codeck lan start

# Without CLI
docker compose -f docker-compose.yml -f docker-compose.lan.yml up
cd scripts && npm install && node scripts/mdns-advertiser.cjs
```

Broadcasts `codeck.local` and `{port}.codeck.local` via mDNS — reachable from phones, tablets, and any LAN device.

## Docker socket (experimental)

```bash
docker compose -f docker-compose.yml -f docker-compose.experimental.yml up
```

Mounts `/var/run/docker.sock` for Docker-in-Docker and dynamic port mapping. Removes container isolation — only use on trusted systems.

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Frontend | Preact 10, @preact/signals, xterm.js 5.5, Vite 5.4 |
| Backend | Node.js 22+, Express 4.18, ws 8.16 |
| Terminal | node-pty 1.0 + xterm.js |
| Memory | SQLite FTS5, session summarizer, context injection |
| Networking | multicast-dns 7.2 (mDNS/Bonjour) |
| Container | Docker, tini, gnome-keyring |
| CLI tools | Claude Code, GitHub CLI, git, openssh |
| Codeck CLI | Commander, @clack/prompts, execa, conf |

## Security

- **Credentials**: OAuth tokens at mode 0600, password hashed with scrypt + salt
- **Rate limiting**: per-route (10/min auth, 200/min general), 7-day session TTL
- **Docker hardening**: `cap_drop ALL`, minimal `cap_add`, `no-new-privileges`, `pids_limit 512`
- **Logging**: automatic sanitization of Anthropic and GitHub tokens

## Documentation

Full technical docs in [`docs/`](docs/README.md):

- [Architecture](docs/ARCHITECTURE.md) — system design, process lifecycle, security model
- [API Reference](docs/API.md) — REST endpoints and WebSocket protocol
- [Services](docs/SERVICES.md) — backend service layer internals
- [Frontend](docs/FRONTEND.md) — Preact SPA, components, signals, CSS
- [Configuration](docs/CONFIGURATION.md) — env vars, Docker, volumes, presets
- [Deployment](docs/DEPLOYMENT.md) — systemd install, VPS setup, service management
- [Known Issues](docs/KNOWN-ISSUES.md) — bugs, tech debt, improvements
