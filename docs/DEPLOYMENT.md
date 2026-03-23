# Deployment Guide

Codeck runs as a single Docker container. No daemon, no CLI tool, no multi-container orchestration.

---

## Quick Install

The fastest way to get started. Pull the pre-built image from GitHub Container Registry:

```bash
curl -fsSL https://codeck.xyz/install | bash
```

Or manually:

```bash
docker pull ghcr.io/cyphercr0w/codeck:latest
docker run -d --name codeck \
  -p 8080:80 \
  -v codeck-workspace:/workspace \
  -v codeck-claude:/root/.claude \
  -v codeck-ssh:/root/.ssh \
  -v codeck-gh:/root/.config/gh \
  -v codeck-data:/data/.codeck \
  --restart unless-stopped \
  ghcr.io/cyphercr0w/codeck:latest --web
```

Available image tags:
- `latest` — latest push to `main`
- `<sha>` — pinned to a specific commit (e.g., `ghcr.io/cyphercr0w/codeck:a1b2c3d`)
- `<version>` — semver release tag (e.g., `ghcr.io/cyphercr0w/codeck:1.0.0`)

---

## Docker Compose

The recommended way to run Codeck with proper resource limits and security hardening:

```bash
# Start
docker compose -f docker/compose.yml up -d

# Stop
docker compose -f docker/compose.yml down

# View logs
docker compose -f docker/compose.yml logs -f
```

Or via npm scripts:

```bash
npm run docker:up       # start
npm run docker:down     # stop
npm run docker:logs     # tail logs
npm run docker:rebuild  # build + start
```

### Compose file location

The single compose file is at `docker/compose.yml`. There are no separate managed or isolated modes.

---

## Building from Source

### Prerequisites

- Docker 20.10+
- Node.js 22+ (for building, not for running)

### Build the base image (one-time)

```bash
npm run docker:build-base
# or directly:
docker build -t codeck-base -f docker/Dockerfile.base .
```

### Build the app image

```bash
npm run build                                    # Build frontend + backend
docker compose -f docker/compose.yml up --build  # Build + start
```

---

## Resource Allocation

### Container limits (compose.yml)

| Resource | Default | Description |
|----------|---------|-------------|
| Memory limit | 0 (unlimited) | Set via `CODECK_MEMORY_LIMIT` env var (e.g., `4G`) |
| Memory reservation | 256M | Minimum guaranteed memory |
| PIDs | 512 | Fork bomb protection |
| Node.js heap | 2048 MB | Set via `CODECK_NODE_HEAP_MB` env var |

### Recommended minimums

| Use case | CPU | RAM | Disk |
|----------|-----|-----|------|
| Personal dev (1 session) | 1 core | 2 GB | 10 GB |
| Active dev (2-3 sessions) | 2 cores | 4 GB | 20 GB |
| Heavy use (agents + dev servers) | 4 cores | 8 GB | 40 GB |

### Tuning

To adjust resource limits, set environment variables before running compose:

```bash
export CODECK_MEMORY_LIMIT=4G
export CODECK_NODE_HEAP_MB=3072
docker compose -f docker/compose.yml up -d
```

Or add to `.env` in the project root:

```env
CODECK_MEMORY_LIMIT=4G
CODECK_NODE_HEAP_MB=3072
```

---

## Reverse Proxy (nginx + SSL)

For production deployments behind a reverse proxy with HTTPS:

### nginx configuration

```nginx
server {
    listen 80;
    server_name codeck.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name codeck.example.com;

    ssl_certificate /etc/letsencrypt/live/codeck.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/codeck.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket timeout (default 60s is too short for terminal sessions)
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

### SSL with certbot

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d codeck.example.com
```

---

## Updating

Volumes persist across container recreation, so updates are non-destructive:

### Pre-built image

```bash
docker pull ghcr.io/cyphercr0w/codeck:latest
docker stop codeck && docker rm codeck
# Re-run the docker run command (same volumes)
docker run -d --name codeck \
  -p 8080:80 \
  -v codeck-workspace:/workspace \
  -v codeck-claude:/root/.claude \
  -v codeck-ssh:/root/.ssh \
  -v codeck-gh:/root/.config/gh \
  -v codeck-data:/data/.codeck \
  --restart unless-stopped \
  ghcr.io/cyphercr0w/codeck:latest --web
```

### Docker Compose

```bash
cd /path/to/codeck
git pull
npm run docker:build-base  # only if Dockerfile.base changed
docker compose -f docker/compose.yml up -d --build
```

### What persists across updates

| Data | Volume | Survives update? |
|------|--------|-----------------|
| Projects and repos | `codeck-workspace` | Yes |
| Claude credentials | `codeck-claude` | Yes |
| SSH keys | `codeck-ssh` | Yes |
| GitHub CLI auth | `codeck-gh` | Yes |
| Codeck config, memory, agents | `codeck-data` | Yes |

**Warning:** `docker compose down -v` deletes all named volumes permanently.

---

## Troubleshooting

### Container won't start

```bash
# Check container logs
docker logs codeck --tail 50

# Check health status
docker inspect codeck --format='{{.State.Health.Status}}'

# Verify images exist
docker images | grep codeck

# Check port conflicts
ss -tlnp | grep :8080
```

### Port 8080 already in use

```bash
# Find what's using the port
ss -tlnp | grep :8080

# Use a different host port
docker run -d --name codeck -p 9090:80 ...
# or in compose, edit the ports mapping
```

### Permission denied on workspace

```bash
# Check volume permissions
docker exec codeck ls -la /workspace

# Fix ownership (if needed)
docker exec codeck chown -R root:root /workspace
```

### WebSocket disconnects behind proxy

Ensure your reverse proxy has:
- `proxy_read_timeout` set to at least 3600s
- `proxy_http_version 1.1` with `Upgrade` and `Connection` headers
- No buffering on WebSocket connections

### Out of memory

```bash
# Check container memory usage
docker stats codeck --no-stream

# Increase memory limit
export CODECK_MEMORY_LIMIT=8G
docker compose -f docker/compose.yml up -d
```

### Health check failing

```bash
# Test the health endpoint manually
docker exec codeck curl -f http://localhost:80/api/auth/status

# Check if the process is running
docker exec codeck ps aux | grep node
```

### Resetting to clean state

```bash
# Remove container and all data (DESTRUCTIVE)
docker compose -f docker/compose.yml down -v

# Remove just the container (preserves volumes)
docker compose -f docker/compose.yml down

# Reset only the Codeck config (preserves workspace)
docker volume rm codeck-data
```

---

## LAN Access

### mDNS (codeck.local)

The container has a built-in mDNS responder that advertises `codeck.local`. For LAN access from other devices, the host-side mDNS advertiser script may be needed:

```bash
cd scripts && npm install
sudo node scripts/mdns-advertiser.cjs  # macOS
# or run as Administrator on Windows
```

### Access URLs

- **Local:** `http://localhost:8080`
- **LAN:** `http://codeck.local` (requires mDNS)
- **Direct IP:** `http://<HOST_IP>:8080`

### Security note

mDNS has no authentication. Only enable LAN mode on trusted networks. Do not use on public WiFi or shared networks.
