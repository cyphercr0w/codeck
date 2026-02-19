# Deployment Guide

Codeck supports three deployment modes:

| Mode | Use case | Detection |
|------|----------|-----------|
| **Docker** (default) | Development, local sandbox | `/.dockerenv` exists |
| **Hosted** (VPS) | Production VPS — daemon on host + runtime in Docker | `SYSTEMD_EXEC_PID` env var |
| **CLI-local** | Direct `node` execution | Fallback |

---

## Hosted Deployment (Linux VPS)

Run Codeck in hosted mode: the daemon runs natively on the host (serves web UI, handles auth) and proxies to a runtime container (runs Claude Code, PTYs, file operations).

### Architecture

```
┌──────────────────────────────────────────────────┐
│  Host (systemd)                                  │
│                                                  │
│  codeck daemon (:80)                             │
│    ├── Web UI (SPA)                              │
│    ├── Auth, sessions, rate limiting             │
│    └── Proxy → runtime container                 │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Docker container (codeck-runtime)         │  │
│  │    ├── :7777 HTTP (localhost only)         │  │
│  │    ├── :7778 WebSocket (localhost only)    │  │
│  │    ├── Claude Code CLI                     │  │
│  │    ├── PTY sessions                        │  │
│  │    └── /workspace (bind mount)             │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Requirements

- Ubuntu 20.04+ (or any systemd-based Linux distro)
- Root/sudo access
- 2+ CPU cores, 4GB+ RAM
- Port 80 (HTTP) open

### Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/cyphercr0w/codeck/main/scripts/install.sh | sudo bash
```

Or manually:

```bash
sudo bash scripts/install.sh
```

### What the Installer Does

1. **Pre-flight checks**: Verifies Linux, root, systemd, package manager
2. **System deps**: `curl`, `git` (no build-essential — daemon has no native modules)
3. **Node.js 22+**: Installs via NodeSource (apt/dnf/yum)
4. **Docker**: Installs via get.docker.com, enables service
5. **User creation**: Creates `codeck` system user, adds to `docker` group
6. **Directories**: Creates `/home/codeck/{workspace,.codeck,.claude,.ssh,.config/gh}`
7. **Codeck**: Clones to `/opt/codeck`, `npm ci --ignore-scripts`, `npm run build`
8. **Docker images**: Builds `codeck-base` and `codeck` images
9. **Environment**: Creates `.env` with `CODECK_UID`/`CODECK_GID`
10. **Systemd**: Installs service unit (manages both daemon and container)

### Service Management

A single `systemctl` command manages both the daemon and the runtime container:

```bash
# Check status
systemctl status codeck

# View daemon logs
journalctl -u codeck -f

# View runtime container logs
docker logs codeck-runtime -f

# Restart (stops container, restarts daemon, starts container)
systemctl restart codeck

# Stop
systemctl stop codeck

# Disable auto-start
systemctl disable codeck
```

### Configuration

The systemd unit file is at `/etc/systemd/system/codeck.service`. Key environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Node environment |
| `CODECK_DAEMON_PORT` | `80` | Daemon HTTP port |
| `CODECK_RUNTIME_URL` | `http://127.0.0.1:7777` | Runtime HTTP URL |
| `CODECK_RUNTIME_WS_URL` | `http://127.0.0.1:7778` | Runtime WebSocket URL |

To override defaults, create a drop-in:

```bash
sudo systemctl edit codeck
```

```ini
[Service]
Environment="CODECK_DAEMON_PORT=8080"
```

Then reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart codeck
```

### Resource Limits

- **Daemon** (host): CPU 100% (1 core), Memory 512MB
- **Runtime** (container): CPU 200% (2 cores), Memory 4GB, PIDs 512
- **Security**: `NoNewPrivileges=true`, `ProtectSystem=full`

### File Paths

| Path | Purpose |
|------|---------|
| `/opt/codeck/` | Application code |
| `/home/codeck/workspace/` | User workspace (bind-mounted into container) |
| `/home/codeck/.claude/` | Claude CLI config (bind-mounted) |
| `/home/codeck/.ssh/` | SSH keys (bind-mounted) |
| `/home/codeck/.config/gh/` | GitHub CLI config (bind-mounted) |
| `/etc/systemd/system/codeck.service` | Systemd unit |
| `/opt/codeck/.env` | UID/GID for container file ownership |

### Updating

```bash
cd /opt/codeck
sudo git pull
npm ci --ignore-scripts
npm run build
docker build -t codeck -f docker/Dockerfile .
sudo systemctl restart codeck
```

### Troubleshooting

**Service won't start**
```bash
# Check daemon logs
journalctl -u codeck -n 50 --no-pager

# Check runtime container
docker logs codeck-runtime --tail 50

# Verify Node.js version
node -v  # Should be 22+

# Verify Docker images exist
docker images | grep codeck
```

**Port 80 already in use**
```bash
# Find what's using port 80
ss -tlnp | grep :80

# Use a different port
sudo systemctl edit codeck
# Add: Environment="CODECK_DAEMON_PORT=8080"
sudo systemctl daemon-reload
sudo systemctl restart codeck
```

**Runtime container won't start**
```bash
# Check container status
docker ps -a | grep codeck-runtime

# Rebuild images
docker build -t codeck-base -f docker/Dockerfile.base .
docker build -t codeck -f docker/Dockerfile .
sudo systemctl restart codeck
```

**Permission denied on workspace**
```bash
sudo chown -R codeck:codeck /home/codeck/
sudo systemctl restart codeck
```

---

## Docker Deployment

### Local mode (default)

Single container running the runtime with the SPA:

```bash
docker compose -f docker/compose.yml up --build    # → http://localhost:80
```

See the main [README.md](../README.md) for full commands.

### Gateway mode

Two containers: daemon (exposed) + runtime (private). Use when deploying behind nginx or exposing to the internet.

```bash
docker compose -f docker/compose.gateway.yml up --build   # → http://localhost:8080
```

**Architecture:**
- **Daemon** (`:8080`, exposed): Auth, rate limiting, audit, proxies to runtime
- **Runtime** (`:7777`/`:7778`, private `codeck_net`): All business logic, PTY, files, memory
- Same Docker image, different entrypoints
- Shared volumes: workspace, claude-config, ssh-data

**Typical nginx config for gateway mode:**
```nginx
server {
    listen 80;
    server_name codeck.example.com;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### CLI-managed deployment

The `@codeck/cli` package automates Docker lifecycle:

```bash
npm run build:cli && npm link -w @codeck/cli
codeck init           # Choose local or gateway mode
codeck start          # Starts the correct compose file
codeck stop
codeck status
```

See [CONFIGURATION.md](CONFIGURATION.md#codeck-cli) for CLI details.

---

## Deployment Mode Detection

Codeck auto-detects its deployment mode at startup and logs it:

```
[Startup] Starting Codeck in systemd mode
```

The detection logic (in `apps/runtime/src/services/environment.ts`):

1. If `SYSTEMD_EXEC_PID` env var exists → `systemd`
2. If `/.dockerenv` file exists → `docker`
3. Otherwise → `cli-local`

Each mode sets appropriate defaults for workspace path and port.
