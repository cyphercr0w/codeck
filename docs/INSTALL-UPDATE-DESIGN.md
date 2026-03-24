# Installation & Update Flow Design

Status: **DRAFT** | Date: 2026-03-23

---

## Executive Summary

Codeck needs a single, polished install-and-update flow that works for developers who know Docker basics but do not want to manage infrastructure. The design centers on three principles:

1. **One script does everything** -- install, update, reconfigure, rollback.
2. **The container is the product** -- no host-side CLI, no daemon, no Node.js requirement.
3. **Data always survives** -- Docker named volumes are the persistence boundary; the container is disposable.

---

## 1. Interactive Installer

### Mechanism

A single bash script (`install.sh`) served at `https://codeck.xyz/install`, invoked as:

```bash
curl -fsSL https://codeck.xyz/install | bash
```

The script detects whether it is a fresh install or an existing installation and adapts its behavior accordingly.

### Interactive Prompts

The installer uses `read -p` prompts with sane defaults. Every prompt can be skipped with Enter to accept the default. Every value can also be overridden via environment variables for fully non-interactive CI/scripted installs.

```
 Codeck Installer v1.0

 Port to expose [8080]:
 Memory limit (e.g. 4g, or 0 for no limit) [0]:
 CPU limit (e.g. 2.0, or 0 for no limit) [0]:
 Auto-start on boot? [Y/n]:
 Image tag (latest, beta, or version like v1.2.0) [latest]:
```

No prompt for data directory. Named volumes are always used. Rationale: bind mounts cause permission hell for 80% of users; the 20% who want bind mounts already know `docker run` flags.

### Environment Variable Overrides

For non-interactive use (CI, Ansible, scripted provisioning):

```bash
CODECK_PORT=9090 CODECK_MEMORY=4g CODECK_CPUS=2 CODECK_TAG=v1.2.0 \
  curl -fsSL https://codeck.xyz/install | bash
```

| Variable | Default | Description |
|----------|---------|-------------|
| `CODECK_PORT` | `8080` | Host port mapped to container port 80 |
| `CODECK_MEMORY` | `0` (unlimited) | Docker `--memory` flag value |
| `CODECK_CPUS` | `0` (unlimited) | Docker `--cpus` flag value |
| `CODECK_TAG` | `latest` | Image tag to pull |
| `CODECK_AUTO_START` | `yes` | Set to `no` to skip `--restart unless-stopped` |
| `CODECK_IMAGE` | `ghcr.io/cyphercr0w/codeck` | Override image registry/name |
| `CODECK_CONTAINER_NAME` | `codeck` | Container name |
| `CODECK_NONINTERACTIVE` | unset | Set to `1` to skip all prompts, use defaults |

### Install Script Behavior

```
1. Pre-flight checks
   - Detect OS (Linux, macOS; fail on Windows with WSL instructions)
   - Check/install Docker
   - Verify Docker is running
   - Check if port is available (ss/lsof)

2. Detect existing installation
   - If container named "codeck" exists:
     → Read current config from container labels (port, memory, cpus, tag)
     → Ask: "Existing installation found. Update? [Y/n]"
     → If yes: jump to update flow (section 2)
     → If no: exit

3. Interactive prompts (unless CODECK_NONINTERACTIVE=1)
   - Each prompt shows env var override name for documentation
   - Validate inputs inline (port range, memory format, cpu format)

4. Pull image
   - docker pull $CODECK_IMAGE:$CODECK_TAG

5. Create and start container
   - Apply all config via docker run flags
   - Store config as container labels for later retrieval:
     --label codeck.port=$PORT
     --label codeck.memory=$MEMORY
     --label codeck.cpus=$CPUS
     --label codeck.tag=$TAG
     --label codeck.installed=$(date -u +%Y-%m-%dT%H:%M:%SZ)
     --label codeck.version=$TAG

6. Wait for healthy (poll /api/status, 30s timeout)

7. Configure firewall (ufw/firewalld) if present

8. Print summary with access URL, management commands, update command
```

### Container Labels as Configuration Store

This is the key architectural choice. Instead of a host-side config file (which requires a host-side tool to read), all installation parameters are stored as Docker container labels. The install script reads them back on subsequent runs:

```bash
# Read existing config
docker inspect codeck --format '{{index .Config.Labels "codeck.port"}}'
docker inspect codeck --format '{{index .Config.Labels "codeck.memory"}}'
```

This means the install script is the only file on the host. No config files, no CLI tools, no state directories.

---

## 2. Update Mechanism

### Recommended Approach: Install Script with `--update` Flag + Web UI Notification

After evaluating all four options:

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **(a)** `codeck update` in container | Zero host dependencies | Container cannot recreate itself; requires Docker socket mount (security risk) | **Rejected** |
| **(b)** Web UI button | Best UX | Same problem as (a) -- container cannot replace itself safely | **Rejected as primary** |
| **(c)** Install script with `--update` | Single tool, no deps, works from host | Requires SSH/terminal access | **Recommended primary** |
| **(d)** Auto-check + notification | Passive, user stays informed | Needs outbound HTTPS to GHCR; notification alone does not update | **Recommended complement** |

The recommended design combines **(c)** as the update executor and **(d)** as the notification system, with a limited version of **(b)** for the trigger.

### Update Flow

#### From the host (primary):

```bash
# Re-run the same install script:
curl -fsSL https://codeck.xyz/install | bash
```

Or explicitly:

```bash
curl -fsSL https://codeck.xyz/install | bash -s -- --update
```

The script detects the existing container, reads its labels, pulls the new image, and recreates the container with the same configuration. Volumes are untouched.

#### What the update does:

```
1. Read config from existing container labels
2. docker pull $IMAGE:$TAG
3. Compare image IDs -- if same, print "Already up to date" and exit
4. docker stop codeck
5. docker rename codeck codeck-prev  (keep for rollback)
6. docker run [same flags from labels] $IMAGE:$TAG
7. Wait for healthy (30s)
8. If healthy:
   → docker rm codeck-prev
   → Print "Updated successfully"
9. If NOT healthy:
   → docker stop codeck && docker rm codeck
   → docker rename codeck-prev codeck
   → docker start codeck
   → Print "Update failed, rolled back to previous version"
```

#### From the web UI (notification + one-click trigger):

The web UI shows an update banner when a new version is available. The banner displays the changelog and provides a command to copy:

```
 Update available: v1.2.0 → v1.3.0

 Run on your server:
 curl -fsSL https://codeck.xyz/install | bash

 [Copy Command]
```

The web UI cannot execute the update itself (the container cannot safely replace itself without Docker socket access, which we explicitly avoid for security). The copy-command pattern is what Coolify, Plausible, and Portainer all use.

### Update Check (in-container)

A lightweight background check runs inside the container every 12 hours:

```
GET https://ghcr.io/v2/cyphercr0w/codeck/tags/list
```

Compare the digest of the `latest` (or pinned) tag against the running container's image digest. The running image digest is available via:

```bash
# Baked into the image at build time as an env var:
ENV CODECK_BUILD_SHA=abc123
ENV CODECK_BUILD_DATE=2026-03-23T12:00:00Z
ENV CODECK_VERSION=1.2.0
```

The check result is exposed via the existing `/api/status` endpoint:

```json
{
  "claude": { ... },
  "version": {
    "current": "1.2.0",
    "buildSha": "abc123",
    "buildDate": "2026-03-23T12:00:00Z",
    "latest": "1.3.0",
    "updateAvailable": true,
    "checkedAt": "2026-03-23T18:00:00Z"
  }
}
```

The frontend reads this and renders the update banner in Settings.

---

## 3. Version Management

### Tagging Strategy

Three tag types, matching the existing CI workflow:

| Tag | Example | Meaning | Use Case |
|-----|---------|---------|----------|
| `latest` | `ghcr.io/cyphercr0w/codeck:latest` | Latest stable release | Default for most users |
| `v<semver>` | `ghcr.io/cyphercr0w/codeck:v1.2.0` | Pinned release | Production, reproducibility |
| `beta` | `ghcr.io/cyphercr0w/codeck:beta` | Pre-release | Early adopters |

### Pinning vs. Following Latest

Users choose at install time via the `CODECK_TAG` env var or the interactive prompt. The choice is stored as a container label (`codeck.tag`).

- **`latest` (default):** Every update pull gets the newest stable release. The update check compares digests.
- **`v1.2.0` (pinned):** The update check compares against the latest semver tag. If a newer version exists, the notification says "v1.3.0 available" but does not auto-upgrade. The user must explicitly change the tag.
- **`beta`:** Same as `latest` but tracks the beta channel.

### Rollback

Built into the update flow. The previous container is kept as `codeck-prev` until the new one is healthy. Manual rollback at any time:

```bash
# List available images
docker images ghcr.io/cyphercr0w/codeck --format "table {{.Tag}}\t{{.CreatedAt}}\t{{.ID}}"

# Rollback to specific version
CODECK_TAG=v1.1.0 curl -fsSL https://codeck.xyz/install | bash
```

For emergency rollback without re-downloading:

```bash
docker stop codeck && docker rm codeck
docker rename codeck-prev codeck
docker start codeck
```

### Breaking Changes in Volumes/Schema

Version metadata file inside the workspace volume:

```
/workspace/.codeck/version.json
{
  "schemaVersion": 2,
  "installedAt": "2026-03-23T12:00:00Z",
  "lastMigration": "2026-03-23T12:00:00Z",
  "history": [
    { "version": "1.2.0", "date": "2026-03-20T00:00:00Z" },
    { "version": "1.3.0", "date": "2026-03-23T12:00:00Z" }
  ]
}
```

Migration strategy:

1. **Schema version** is an integer, incremented only when volume data format changes.
2. On startup, the runtime reads `version.json`. If `schemaVersion` is behind the expected version, it runs migrations sequentially (e.g., migration 1->2, 2->3).
3. Migrations are TypeScript functions in `apps/runtime/src/migrations/`. Each is idempotent.
4. If `version.json` does not exist (fresh install or pre-versioning install), the runtime creates it at schema version 0 and runs all migrations from 0 to current.
5. The runtime refuses to start if `schemaVersion` is higher than it supports (downgrade protection). Error message tells the user to upgrade.

Example migration scenarios:
- **Config format change:** Migration reads old format, writes new format, bumps schema version.
- **Database schema change:** Migration runs ALTER TABLE or recreates tables.
- **File layout change:** Migration moves files to new locations.

---

## 4. Resource Configuration

### Changing Resources After Install

Re-run the installer with new values:

```bash
CODECK_MEMORY=8g CODECK_CPUS=4 curl -fsSL https://codeck.xyz/install | bash
```

The script reads existing labels, merges with new env vars (new values override), and recreates the container. Same as an update but without pulling a new image (unless one is available).

This is intentionally the same workflow as updating. One command, one flow. No separate "reconfigure" concept.

### Exposing Additional Ports

Two mechanisms, matching the current architecture:

#### At install time (static ports):

```bash
CODECK_EXTRA_PORTS="3000,5173,8000" curl -fsSL https://codeck.xyz/install | bash
```

These are stored as the label `codeck.extra_ports` and applied as additional `-p` flags. Each maps host:container 1:1 (e.g., `-p 3000:3000`).

#### At runtime (dynamic ports via API):

The existing `POST /api/system/add-port` endpoint (referenced in KNOWN-ISSUES.md item 14) handles runtime port exposure. In isolated mode without Docker socket access, this requires the install script to recreate the container with the new port. The API endpoint writes the desired port to a file, and the update/reconfigure flow picks it up.

Practical flow for runtime port addition:
1. Dev server starts on port 3000 inside the container.
2. Frontend shows "Port 3000 not exposed" with a command to copy:
   ```
   CODECK_EXTRA_PORTS=3000 curl -fsSL https://codeck.xyz/install | bash
   ```
3. User runs it. Container is recreated with port 3000 exposed. Downtime: ~5 seconds.

This is a conscious trade-off: no Docker socket inside the container (security) means port changes require container recreation (minor inconvenience). The alternative (socket mount) is documented for power users who want zero-downtime port changes.

---

## 5. Build-Time Version Embedding

The CI workflow must bake version info into the image. Changes to `.github/workflows/docker.yml`:

```yaml
- name: Build app image
  run: |
    docker build -t app:latest \
      --build-arg BASE_IMAGE=codeck-base:latest \
      --build-arg CODECK_VERSION=${{ steps.meta.outputs.tag }} \
      --build-arg CODECK_BUILD_SHA=${{ github.sha }} \
      --build-arg CODECK_BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
      -f docker/Dockerfile .
```

And in `docker/Dockerfile`:

```dockerfile
ARG CODECK_VERSION=dev
ARG CODECK_BUILD_SHA=unknown
ARG CODECK_BUILD_DATE=unknown
ENV CODECK_VERSION=$CODECK_VERSION
ENV CODECK_BUILD_SHA=$CODECK_BUILD_SHA
ENV CODECK_BUILD_DATE=$CODECK_BUILD_DATE
```

The runtime reads these env vars and exposes them via `/api/status`.

---

## 6. Complete Install Script (Pseudocode)

```bash
#!/usr/bin/env bash
set -euo pipefail

IMAGE="${CODECK_IMAGE:-ghcr.io/cyphercr0w/codeck}"
CONTAINER="${CODECK_CONTAINER_NAME:-codeck}"
NONINTERACTIVE="${CODECK_NONINTERACTIVE:-0}"

# ── Detect existing installation ──────────────────────────────
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  EXISTING=1
  # Read config from labels
  CUR_PORT=$(docker inspect $CONTAINER --format '{{index .Config.Labels "codeck.port"}}' 2>/dev/null || echo "")
  CUR_MEMORY=$(docker inspect $CONTAINER --format '{{index .Config.Labels "codeck.memory"}}' 2>/dev/null || echo "")
  CUR_CPUS=$(docker inspect $CONTAINER --format '{{index .Config.Labels "codeck.cpus"}}' 2>/dev/null || echo "")
  CUR_TAG=$(docker inspect $CONTAINER --format '{{index .Config.Labels "codeck.tag"}}' 2>/dev/null || echo "")
  CUR_EXTRA_PORTS=$(docker inspect $CONTAINER --format '{{index .Config.Labels "codeck.extra_ports"}}' 2>/dev/null || echo "")
else
  EXISTING=0
fi

# ── Resolve config (env var > existing label > default) ───────
resolve() {
  local env_val="$1" label_val="$2" default="$3"
  if [ -n "$env_val" ]; then echo "$env_val"
  elif [ -n "$label_val" ]; then echo "$label_val"
  else echo "$default"; fi
}

PORT=$(resolve "${CODECK_PORT:-}" "${CUR_PORT:-}" "")
MEMORY=$(resolve "${CODECK_MEMORY:-}" "${CUR_MEMORY:-}" "")
CPUS=$(resolve "${CODECK_CPUS:-}" "${CUR_CPUS:-}" "")
TAG=$(resolve "${CODECK_TAG:-}" "${CUR_TAG:-}" "")
EXTRA_PORTS=$(resolve "${CODECK_EXTRA_PORTS:-}" "${CUR_EXTRA_PORTS:-}" "")

# ── Interactive prompts (if not non-interactive) ──────────────
if [ "$NONINTERACTIVE" != "1" ]; then
  if [ "$EXISTING" = "1" ]; then
    echo "Existing Codeck installation found."
    echo "  Port: ${CUR_PORT:-8080}  Memory: ${CUR_MEMORY:-unlimited}  CPUs: ${CUR_CPUS:-unlimited}  Tag: ${CUR_TAG:-latest}"
  fi

  read -p "Port [${PORT:-8080}]: " input; PORT="${input:-${PORT:-8080}}"
  read -p "Memory limit (e.g. 4g, 0=unlimited) [${MEMORY:-0}]: " input; MEMORY="${input:-${MEMORY:-0}}"
  read -p "CPU limit (e.g. 2.0, 0=unlimited) [${CPUS:-0}]: " input; CPUS="${input:-${CPUS:-0}}"
  read -p "Image tag (latest/beta/v1.x.x) [${TAG:-latest}]: " input; TAG="${input:-${TAG:-latest}}"
fi

# Apply final defaults
PORT="${PORT:-8080}"
MEMORY="${MEMORY:-0}"
CPUS="${CPUS:-0}"
TAG="${TAG:-latest}"

# ── Pull image ────────────────────────────────────────────────
docker pull "${IMAGE}:${TAG}"

# ── Build docker run flags ────────────────────────────────────
FLAGS=(
  -d --name "$CONTAINER" --init
  -p "${PORT}:80"
  -v codeck-workspace:/workspace
  -v codeck-claude:/root/.claude
  -v codeck-ssh:/root/.ssh
  -v codeck-gh:/root/.config/gh
  --cap-drop ALL
  --cap-add CHOWN --cap-add SETUID --cap-add SETGID
  --cap-add NET_BIND_SERVICE --cap-add KILL --cap-add DAC_OVERRIDE
  --security-opt no-new-privileges:true
  --stop-timeout 30
  --label "codeck.port=${PORT}"
  --label "codeck.memory=${MEMORY}"
  --label "codeck.cpus=${CPUS}"
  --label "codeck.tag=${TAG}"
  --label "codeck.extra_ports=${EXTRA_PORTS}"
  --label "codeck.installed=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
)

# Conditional flags
[ "$MEMORY" != "0" ] && FLAGS+=(--memory "$MEMORY")
[ "$CPUS" != "0" ] && FLAGS+=(--cpus "$CPUS")
[ "${CODECK_AUTO_START:-yes}" = "yes" ] && FLAGS+=(--restart unless-stopped)

# Extra ports
if [ -n "$EXTRA_PORTS" ]; then
  IFS=',' read -ra PORTS <<< "$EXTRA_PORTS"
  for p in "${PORTS[@]}"; do FLAGS+=(-p "${p}:${p}"); done
fi

# ── Replace existing container (with rollback) ────────────────
if [ "$EXISTING" = "1" ]; then
  docker stop "$CONTAINER" 2>/dev/null || true
  docker rename "$CONTAINER" "${CONTAINER}-prev" 2>/dev/null || true
fi

docker run "${FLAGS[@]}" "${IMAGE}:${TAG}" --web

# ── Health check with rollback ────────────────────────────────
HEALTHY=0
for i in $(seq 1 30); do
  if docker exec "$CONTAINER" curl -sf http://localhost:80/api/status &>/dev/null; then
    HEALTHY=1; break
  fi
  sleep 1
done

if [ "$HEALTHY" = "0" ] && [ "$EXISTING" = "1" ]; then
  echo "Update failed — rolling back..."
  docker stop "$CONTAINER" && docker rm "$CONTAINER"
  docker rename "${CONTAINER}-prev" "$CONTAINER"
  docker start "$CONTAINER"
  echo "Rolled back to previous version."
  exit 1
fi

# Clean up previous container on success
docker rm "${CONTAINER}-prev" 2>/dev/null || true
```

---

## 7. Comparison with Prior Art

| Feature | Codeck (proposed) | Coolify | Dokku | Plausible |
|---------|-------------------|---------|-------|-----------|
| Install | `curl \| bash` | `curl \| bash` | `apt install` | `docker compose` |
| Update | Same script | Self-update via web UI (has Docker socket) | `apt upgrade` | `docker compose pull && up` |
| Config storage | Container labels | SQLite DB | Host filesystem | `.env` file |
| Rollback | Automatic on failure | Manual | `git push` old version | `docker compose` with old tag |
| Host dependencies | Docker only | Docker only | Docker + buildpacks | Docker + compose |
| Version pinning | Tag selection | Auto-update channel | Git tags | Docker tag in compose |
| Port changes | Container recreate | Dynamic (socket) | Nginx routing | Compose edit |

Codeck's approach is closest to Coolify's simplicity but avoids the Docker socket dependency that Coolify requires for self-update. The trade-off is that updates require SSH access to run the script, which is appropriate for the target user (developer with VPS).

---

## 8. Implementation Plan

### Phase 1: Version Infrastructure (1-2 days)

1. Add `CODECK_VERSION`, `CODECK_BUILD_SHA`, `CODECK_BUILD_DATE` build args to `Dockerfile`.
2. Update CI workflow to pass build args.
3. Add version info to `/api/status` response.
4. Create `/workspace/.codeck/version.json` on first boot.
5. Add migration runner skeleton (`apps/runtime/src/migrations/`).

### Phase 2: Install Script Rewrite (1-2 days)

1. Add interactive prompts to `scripts/install.sh`.
2. Add container label read/write logic.
3. Add rollback-on-failure flow.
4. Add existing installation detection.
5. Add env var override support.
6. Add extra ports support.
7. Test on Ubuntu 22.04, 24.04, Debian 12, macOS (Docker Desktop).

### Phase 3: Update Check (1 day)

1. Add background GHCR tag check service (`apps/runtime/src/services/update-check.ts`).
2. Add `version` field to `/api/status` response.
3. Add update banner to web UI Settings view.
4. Store check result in memory (not disk -- ephemeral is fine).

### Phase 4: Documentation (0.5 days)

1. Update `docs/DEPLOYMENT.md` with new install/update instructions.
2. Update `CLAUDE.md` Quick Start section.
3. Update `README.md` install section.
4. Add `docs/UPDATING.md` with rollback procedures.

---

## 9. Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Config storage | Container labels | No host-side files needed; config travels with container metadata |
| Update executor | Host-side script | Container cannot safely replace itself without Docker socket |
| Update notification | In-container GHCR check + web banner | Passive awareness without requiring user to check manually |
| Volume strategy | Named volumes only | Bind mounts cause permission issues; power users can override via env vars |
| Port changes | Container recreate | Security (no socket) outweighs convenience (5s downtime) |
| Rollback | Keep previous container + auto-rollback | Zero-risk updates; always recoverable |
| Schema migration | Integer version + sequential migrations | Simple, proven pattern; idempotent migrations prevent corruption |
| Interactive mode | Prompts with env var overrides | Friendly for humans, scriptable for automation |
