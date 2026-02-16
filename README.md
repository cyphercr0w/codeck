# Codeck

Docker sandbox that runs **Claude Code CLI** and exposes it through a web interface on port 80. Authenticate with Claude OAuth, open interactive terminals, browse files, manage GitHub integration, and monitor resource usage — all from the browser.

## Quick Start (CLI)

The `codeck` CLI automates the entire setup and lifecycle:

```bash
# Install the CLI
cd cli && npm install && npm run build && npm link

# Interactive setup — builds base image, generates config, starts container
codeck init

# Open the webapp
codeck open
```

On first visit: set a local password, authenticate with Claude OAuth, and choose a configuration preset.

## CLI Commands

| Command | Description |
|---------|-------------|
| `codeck init` | Interactive setup wizard (port, extra ports, LAN, tokens, base image build) |
| `codeck start` | Start the container (`--dev` for development mode) |
| `codeck stop` | Stop the container |
| `codeck restart` | Stop + start (`--dev` for development mode) |
| `codeck status` | Show container status, URLs, and configuration |
| `codeck logs` | Stream container logs (`-n 100` for more lines) |
| `codeck doctor` | Diagnose environment issues (Docker, images, ports, config) |
| `codeck open` | Open the webapp in your default browser |
| `codeck lan` | Manage LAN access via mDNS (`start`/`stop`/`status`) |

Re-running `codeck init` is safe — it loads existing config as defaults and never destroys volumes.

## Manual Setup (without CLI)

```bash
# 1. Build the base image (one time, ~5 min)
docker build -t codeck-base -f Dockerfile.base .

# 2. (Optional) Copy and edit the environment file
echo "CODECK_PORT=80" > .env

# 3. Start the container
docker compose up

# 4. Open http://localhost
```

### Development mode

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

### Base Image

The base image includes heavy dependencies (Node.js, Claude CLI, GitHub CLI, node-pty). Build it once:

```bash
docker build -t codeck-base -f Dockerfile.base .
```

Rebuild only when `Dockerfile.base` changes.

## LAN Access (`codeck.local`)

Access Codeck from phones, tablets, and other devices on your local network. Works the same on all platforms (Linux, Windows, macOS).

**With CLI:**

```bash
codeck lan start   # Start mDNS advertiser for LAN discovery
```

**Without CLI:**

```bash
# 1. Start Codeck with LAN overlay
docker compose -f docker-compose.yml -f docker-compose.lan.yml up

# 2. Run the host-side mDNS advertiser (requires admin)
cd scripts && npm install
node scripts/mdns-advertiser.cjs
```

The advertiser script broadcasts `codeck.local` and `{port}.codeck.local` via mDNS. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for details.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Docker Container (node:22-slim)                     │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  Express Server (:80)                          │  │
│  │  ├── REST API (/api/*)                         │  │
│  │  ├── WebSocket (terminal I/O + logs)           │  │
│  │  └── Static files (Vite build)                 │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Claude   │  │ node-pty │  │ mDNS responder    │  │
│  │ Code CLI │  │ sessions │  │ (LAN mode)        │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│                                                      │
│  /workspace/  /workspace/.codeck/  /root/.claude/  │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│  Browser (Preact + xterm.js)                         │
│  ├── Auth view (password + OAuth + preset wizard)    │
│  ├── Home (account, resources, usage dashboard)      │
│  ├── Files (file browser + editor)                   │
│  ├── Claude (PTY terminals, up to 5 sessions)        │
│  ├── Integrations (GitHub SSH + CLI device flow)     │
│  └── Config (viewer/editor for .codeck/)           │
└──────────────────────────────────────────────────────┘
```

## Port Preview

Dev servers running inside the container are accessible via direct port mapping (no proxy):

| Access | URL |
|--------|-----|
| Same machine | `http://localhost:{port}` (e.g., `http://localhost:5173`) |
| LAN devices | `http://codeck.local:{port}` |
| Direct IP | `http://{HOST_IP}:{port}` |

Only the Codeck port (default 80) is mapped initially. Additional ports can be added via the dashboard UI, the `POST /api/system/add-port` API, or `docker-compose.override.yml`. Servers must bind to `0.0.0.0` (not `localhost`) to be reachable. The port scanner detects active ports every 5 seconds.

## Features

- **Local password auth** with hashed credentials (scrypt) and 7-day session tokens
- **Claude OAuth PKCE** for CLI authentication (paste code or token directly)
- **Up to 5 concurrent PTY terminals** via node-pty + xterm.js + WebSocket
- **Collapsible sidebar** with mobile slide-down menu
- **File browser** with directory creation, text file viewing/editing
- **Project creation** — new folder, existing folder, or git clone
- **GitHub integration** — CLI device flow login + SSH key management
- **Preset system** — manifest-driven configuration (Default + Empty presets)
- **Persistent memory** — summary, decisions, per-project context, preferences
- **Dashboard** — CPU, memory, disk, active sessions, Claude API usage
- **Port preview** — direct port mapping for dev servers inside the container
- **LAN access** — `codeck.local` from phones/tablets via mDNS
- **Config viewer/editor** for `/workspace/.codeck/` agent data files
- **Workspace export** as `.tar.gz`
- **Centralized logging** with automatic token sanitization

## Production Deployment (Linux VPS)

For running Codeck natively on a Linux VPS as a systemd service (e.g., for SaaS Cloud):

```bash
curl -fsSL https://codeck.app/install.sh | sudo bash
```

This installs Node.js, Docker, Claude CLI, creates a `codeck` system user, and sets up a systemd service. After installation:

```bash
systemctl status codeck       # Check service status
journalctl -u codeck -f       # Follow logs
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full guide, configuration options, and troubleshooting.

## Docker Socket Access (Experimental)

By default, Codeck runs in **secure mode** without access to the host Docker daemon. Docker commands (`docker ps`, `docker compose`, etc.) will not work inside the container, and dynamic port exposure via the dashboard requires manual configuration.

To enable Docker access (for advanced workflows like Docker-in-Docker, dynamic port mapping, or container orchestration), use the experimental overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.experimental.yml up
```

**Warning:** This mounts `/var/run/docker.sock` into the container, granting full access to the host Docker daemon. This removes container isolation entirely. Only use on trusted systems.

When experimental mode is active, the dashboard shows a persistent warning banner.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Preact 10.19, @preact/signals, xterm.js 5.5, Vite 5.4 |
| Backend | Node.js 22+, Express 4.18, ws 8.16 |
| Terminal | node-pty 1.0 + xterm.js |
| Networking | multicast-dns 7.2 (mDNS/Bonjour) |
| Container | Docker, tini (PID 1), gnome-keyring |
| CLI | Claude Code, GitHub CLI, git, openssh |
| Codeck CLI | Commander, @clack/prompts, execa, conf |

## Security

- **Docker hardening**: `cap_drop ALL`, minimal `cap_add`, `no-new-privileges`, `pids_limit 512`
- **Credentials**: OAuth tokens at mode 0600, password hashed with scrypt + random salt
- **Rate limiting**: per-route (10/min auth, 200/min general), 7-day session TTL
- **Isolation**: Path traversal protection, PTY sandboxed inside container
- **Logging**: Automatic sanitization of Anthropic and GitHub tokens

## Documentation

Full technical documentation in [`docs/`](docs/README.md):

- [Architecture](docs/ARCHITECTURE.md) — system design, process lifecycle, security model
- [API Reference](docs/API.md) — REST endpoints and WebSocket protocol
- [Services](docs/SERVICES.md) — backend service layer internals
- [Frontend](docs/FRONTEND.md) — Preact SPA, components, signals, CSS
- [Configuration](docs/CONFIGURATION.md) — env vars, Docker, volumes, presets
- [Deployment](docs/DEPLOYMENT.md) — systemd install, VPS setup, service management
- [Known Issues](docs/KNOWN-ISSUES.md) — bugs, tech debt, improvements
