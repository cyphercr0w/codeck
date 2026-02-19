# Deployment Guide

Codeck supports three deployment modes:

| Mode | Use case | Detection |
|------|----------|-----------|
| **Docker** (default) | Development, local sandbox | `/.dockerenv` exists |
| **Systemd** | Production VPS (SaaS Cloud) | `SYSTEMD_EXEC_PID` env var |
| **CLI-local** | Direct `node` execution | Fallback |

---

## Systemd Deployment (Linux VPS)

Run Codeck natively on a Linux VPS as a systemd service. Docker is available on the host so Claude can use it directly.

### Requirements

- Ubuntu 20.04+ (or any systemd-based Linux distro)
- Root/sudo access
- 2+ CPU cores, 4GB+ RAM
- Ports 80 (HTTP) open

### Quick Install

```bash
curl -fsSL https://codeck.app/install.sh | sudo bash
```

Or manually:

```bash
sudo bash scripts/install.sh
```

### What the Installer Does

1. **Pre-flight checks**: Verifies Linux, root, systemd
2. **Node.js 22+**: Installs via NodeSource (apt/dnf/yum)
3. **Docker**: Installs via get.docker.com, enables service
4. **Claude CLI**: `npm install -g @anthropic-ai/claude-code`
5. **User creation**: Creates `codeck` system user, adds to `docker` group
6. **Directories**: Creates `/home/codeck/{workspace,.codeck,.claude,.ssh}`
7. **Codeck**: Downloads to `/opt/codeck`, runs `npm install --production`
8. **Systemd**: Copies unit file, enables and starts service

### Service Management

```bash
# Check status
systemctl status codeck

# View logs (follow)
journalctl -u codeck -f

# View recent logs
journalctl -u codeck --since "1 hour ago"

# Restart
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
| `CODECK_PORT` | `80` | HTTP port |
| `WORKSPACE` | `/home/codeck/workspace` | Workspace root |

To override defaults, create a drop-in:

```bash
sudo systemctl edit codeck
```

```ini
[Service]
Environment="CODECK_PORT=8080"
Environment="WORKSPACE=/data/workspace"
```

Then reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart codeck
```

### Resource Limits

The service has built-in resource limits:

- **CPU**: 200% (2 cores max)
- **Memory**: 4GB max
- **Security**: `NoNewPrivileges=true`

### File Paths

| Path | Purpose |
|------|---------|
| `/opt/codeck/` | Application code |
| `/home/codeck/workspace/` | User workspace |
| `/home/codeck/.codeck/` | Agent data (memory, rules, skills) |
| `/home/codeck/.claude/` | Claude CLI config |
| `/home/codeck/.ssh/` | SSH keys |
| `/etc/systemd/system/codeck.service` | Systemd unit |

### Updating

```bash
# Stop service
sudo systemctl stop codeck

# Download new version
cd /opt/codeck
sudo wget -O /tmp/codeck.tar.gz https://github.com/codeck-sh/codeck/releases/latest/download/codeck.tar.gz
sudo tar xzf /tmp/codeck.tar.gz -C /opt/codeck
sudo npm install --production

# Start service
sudo systemctl start codeck
```

### Troubleshooting

**Service won't start**
```bash
# Check logs for errors
journalctl -u codeck -n 50 --no-pager

# Verify Node.js version
node -v  # Should be 22+

# Verify permissions
ls -la /opt/codeck/
ls -la /home/codeck/
```

**Port 80 already in use**
```bash
# Find what's using port 80
ss -tlnp | grep :80

# Use a different port
sudo systemctl edit codeck
# Add: Environment="CODECK_PORT=8080"
sudo systemctl daemon-reload
sudo systemctl restart codeck
```

**Docker not working for Claude**
```bash
# Verify codeck user is in docker group
groups codeck

# If not, add it
sudo usermod -aG docker codeck
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
docker compose up --build              # → http://localhost:80
```

See the main [README.md](../README.md) for full commands.

### Gateway mode

Two containers: daemon (exposed) + runtime (private). Use when deploying behind nginx or exposing to the internet.

```bash
docker compose -f docker-compose.gateway.yml up --build   # → http://localhost:8080
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
