#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# Codeck Installer & Updater
#
# Handles fresh install, updates, and resource changes.
# Config is stored as Docker container labels — no host-side state files.
#
# Usage:
#   curl -fsSL https://codeck.xyz/install | bash
#   CODECK_PORT=3000 curl -fsSL https://codeck.xyz/install | bash  # non-interactive
#
# Environment overrides (skip prompts):
#   CODECK_PORT     — host port (default: 8080)
#   CODECK_MEMORY   — memory limit, e.g. "4g" (default: unlimited)
#   CODECK_CPUS     — CPU limit, e.g. "2" (default: unlimited)
#   CODECK_IMAGE    — Docker image (default: ghcr.io/cyphercr0w/codeck:latest)
#   CODECK_NAME     — container name (default: codeck)
# ═══════════════════════════════════════════════════════════════════════

# Wrapped in main() so `curl | bash` downloads the entire script before executing.
# Without this, bash reads line-by-line from the pipe and can fail on slow connections.
main() {
set -euo pipefail

VERSION="1.0.0"
DEFAULT_IMAGE="ghcr.io/cyphercr0w/codeck:latest"
DEFAULT_PORT="80"
DEFAULT_NAME="codeck"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'; DIM='\033[2m'

log()  { echo -e "${GREEN}  ✓${NC} $*"; }
info() { echo -e "${CYAN}  ›${NC} $*"; }
warn() { echo -e "${YELLOW}  !${NC} $*"; }
err()  { echo -e "${RED}  ✗${NC} $*" >&2; }
die()  { err "$*"; exit 1; }

# Prompt with default (skip if env var set)
ask() {
  local var="$1" prompt="$2" default="$3"
  local current="${!var:-}"
  if [[ -n "$current" ]]; then
    echo -e "${DIM}  ${prompt} [${current}]${NC}"
    return
  fi
  if [[ -t 0 ]]; then
    read -rp "  ${prompt} [${default}]: " value
    printf -v "$var" '%s' "${value:-$default}"
  else
    printf -v "$var" '%s' "$default"
  fi
}

# Read config from existing container labels
read_existing_config() {
  local name="$1"
  if docker inspect "$name" &>/dev/null 2>&1; then
    EXISTING_PORT=$(docker inspect --format '{{index .Config.Labels "codeck.port"}}' "$name" 2>/dev/null || echo "")
    EXISTING_MEMORY=$(docker inspect --format '{{index .Config.Labels "codeck.memory"}}' "$name" 2>/dev/null || echo "")
    EXISTING_CPUS=$(docker inspect --format '{{index .Config.Labels "codeck.cpus"}}' "$name" 2>/dev/null || echo "")
    EXISTING_IMAGE=$(docker inspect --format '{{.Config.Image}}' "$name" 2>/dev/null || echo "")
    return 0
  fi
  return 1
}

# ─── Header ──────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}  ╔═══════════════════════════════════╗${NC}"
echo -e "${BOLD}  ║         ${CYAN}Codeck Installer${NC}${BOLD}          ║${NC}"
echo -e "${BOLD}  ╚═══════════════════════════════════╝${NC}"
echo ""

# ─── Auto-elevate ────────────────────────────────────────────────────

if [[ "$EUID" -ne 0 ]]; then
  if command -v sudo &>/dev/null; then
    if [[ -f "$0" ]]; then
      exec sudo -E bash "$0" "$@"
    else
      # Running via pipe (curl | bash) — $0 is "bash", not a file.
      # Save the running script to a temp file and re-exec with sudo.
      TMPSCRIPT="$(mktemp /tmp/codeck-install.XXXXXX.sh)"
      # The entire script is already in memory (main() wrapper), so we can
      # extract it from the current process by re-downloading.
      curl -fsSL https://codeck.xyz/install > "$TMPSCRIPT"
      exec sudo -E bash "$TMPSCRIPT" "$@"
    fi
  fi
fi

# ─── Detect OS ───────────────────────────────────────────────────────

OS="$(uname -s)"
case "$OS" in
  Linux)  info "OS: Linux $(uname -r)" ;;
  Darwin) info "OS: macOS $(sw_vers -productVersion 2>/dev/null || echo '')" ;;
  *)      die "Unsupported OS: $OS" ;;
esac

# ─── Docker ──────────────────────────────────────────────────────────

if ! command -v docker &>/dev/null; then
  info "Docker not found — installing..."
  if [[ "$OS" == "Linux" ]]; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker 2>/dev/null || true
    systemctl start docker 2>/dev/null || true
  else
    die "Install Docker Desktop: https://docker.com/products/docker-desktop"
  fi
fi

if ! docker info &>/dev/null 2>&1; then
  [[ "$OS" == "Linux" ]] && { systemctl start docker 2>/dev/null || true; sleep 2; }
  docker info &>/dev/null 2>&1 || die "Docker is not running. Start Docker and retry."
fi

log "Docker $(docker --version | grep -oP '\d+\.\d+\.\d+' | head -1)"

# ─── Detect existing installation ────────────────────────────────────

CONTAINER_NAME="${CODECK_NAME:-$DEFAULT_NAME}"
IS_UPDATE=false

if read_existing_config "$CONTAINER_NAME"; then
  IS_UPDATE=true
  echo ""
  info "Existing Codeck found — this will ${BOLD}update${NC} it."
  info "Your data (workspace, config, keys) will be preserved."
  echo ""

  # Use existing config as defaults
  DEFAULT_PORT="${EXISTING_PORT:-$DEFAULT_PORT}"
  DEFAULT_IMAGE="${EXISTING_IMAGE:-$DEFAULT_IMAGE}"
fi

# ─── Configuration ───────────────────────────────────────────────────

CODECK_IMAGE="${CODECK_IMAGE:-$DEFAULT_IMAGE}"
CODECK_PORT="${CODECK_PORT:-}"
CODECK_MEMORY="${CODECK_MEMORY:-}"
CODECK_CPUS="${CODECK_CPUS:-}"

ask CODECK_PORT "Port" "$DEFAULT_PORT"
ask CODECK_MEMORY "Memory limit in GB (e.g. 4, or blank for unlimited)" "${EXISTING_MEMORY:-}"
ask CODECK_CPUS "CPU limit (e.g. 2, or blank for unlimited)" "${EXISTING_CPUS:-}"

# Normalize memory input: "4" → "4g", "512m" stays, "" stays
if [[ -n "$CODECK_MEMORY" && "$CODECK_MEMORY" =~ ^[0-9]+$ ]]; then
  CODECK_MEMORY="${CODECK_MEMORY}g"
fi

echo ""

# ─── Pull image ──────────────────────────────────────────────────────

info "Pulling ${CODECK_IMAGE}..."
docker pull "$CODECK_IMAGE" || die "Failed to pull image. Check your internet connection."
log "Image pulled"

# ─── Build docker run args ───────────────────────────────────────────

DOCKER_ARGS=(
  --name "$CONTAINER_NAME"
  --restart unless-stopped
  --init
  -p "${CODECK_PORT}:80"
  -v codeck-workspace:/workspace
  -v codeck-claude:/root/.claude
  -v codeck-ssh:/root/.ssh
  -v codeck-gh:/root/.config/gh
  -e CODECK_DIR=/workspace/.codeck
  -e WORKSPACE=/workspace
  --cap-drop ALL
  --cap-add CHOWN
  --cap-add SETUID
  --cap-add SETGID
  --cap-add NET_BIND_SERVICE
  --cap-add KILL
  --cap-add DAC_OVERRIDE
  --security-opt no-new-privileges:true
  --stop-timeout 30
  # Store config as labels for future updates
  --label "codeck.port=${CODECK_PORT}"
  --label "codeck.image=${CODECK_IMAGE}"
  --label "codeck.installer=${VERSION}"
)

# Optional resource limits
[[ -n "$CODECK_MEMORY" ]] && DOCKER_ARGS+=(--memory "$CODECK_MEMORY")
[[ -n "$CODECK_CPUS" ]] && DOCKER_ARGS+=(--cpus "$CODECK_CPUS")
[[ -n "$CODECK_MEMORY" ]] && DOCKER_ARGS+=(--label "codeck.memory=${CODECK_MEMORY}")
[[ -n "$CODECK_CPUS" ]] && DOCKER_ARGS+=(--label "codeck.cpus=${CODECK_CPUS}")

# ─── Stop existing + rollback safety ────────────────────────────────

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  # Rename old container for rollback
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rename "$CONTAINER_NAME" "${CONTAINER_NAME}-prev" 2>/dev/null || true
  info "Previous container saved as ${CONTAINER_NAME}-prev (rollback safety)"
fi

# ─── Start new container ─────────────────────────────────────────────

info "Starting Codeck..."
docker run -d "${DOCKER_ARGS[@]}" "$CODECK_IMAGE" --web || {
  # Rollback on start failure
  err "Failed to start new container"
  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}-prev$"; then
    warn "Rolling back to previous version..."
    docker rename "${CONTAINER_NAME}-prev" "$CONTAINER_NAME"
    docker start "$CONTAINER_NAME" 2>/dev/null || true
    die "Rollback complete. Previous version is running."
  fi
  die "No previous version to rollback to."
}

# ─── Health check with auto-rollback ─────────────────────────────────

info "Waiting for health check..."
HEALTHY=false
for i in $(seq 1 30); do
  if docker exec "$CONTAINER_NAME" curl -sf http://localhost:80/api/auth/status &>/dev/null; then
    HEALTHY=true
    break
  fi
  sleep 1
done

if [[ "$HEALTHY" != "true" ]]; then
  warn "New version not healthy after 30s"
  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}-prev$"; then
    warn "Auto-rolling back..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
    docker rename "${CONTAINER_NAME}-prev" "$CONTAINER_NAME"
    docker start "$CONTAINER_NAME" 2>/dev/null || true
    die "Rollback complete. Check: docker logs ${CONTAINER_NAME}"
  fi
  warn "No previous version. Check: docker logs ${CONTAINER_NAME}"
fi

# Clean up old container after successful start
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}-prev$"; then
  docker rm "${CONTAINER_NAME}-prev" 2>/dev/null || true
fi

log "Health check passed"

# ─── Firewall ────────────────────────────────────────────────────────

if command -v ufw &>/dev/null; then
  ufw allow "${CODECK_PORT}/tcp" >/dev/null 2>&1 && log "Firewall: port ${CODECK_PORT} allowed" || true
elif command -v firewall-cmd &>/dev/null; then
  firewall-cmd --permanent --add-port="${CODECK_PORT}/tcp" >/dev/null 2>&1
  firewall-cmd --reload >/dev/null 2>&1
  log "Firewall: port ${CODECK_PORT} allowed"
fi

# ─── Done ────────────────────────────────────────────────────────────

PUBLIC_IP=$(curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

echo ""
if [[ "$IS_UPDATE" == "true" ]]; then
  echo -e "${GREEN}${BOLD}  ═══════════════════════════════════════${NC}"
  echo -e "${GREEN}${BOLD}    Codeck updated successfully!${NC}"
  echo -e "${GREEN}${BOLD}  ═══════════════════════════════════════${NC}"
else
  echo -e "${GREEN}${BOLD}  ═══════════════════════════════════════${NC}"
  echo -e "${GREEN}${BOLD}    Codeck installed successfully!${NC}"
  echo -e "${GREEN}${BOLD}  ═══════════════════════════════════════${NC}"
fi
echo ""
echo -e "  Open: ${CYAN}${BOLD}http://${PUBLIC_IP}:${CODECK_PORT}${NC}"
echo -e "  ${DIM}Set up your password and connect your Anthropic account to get started.${NC}"
echo ""
echo -e "  ${BOLD}Manage:${NC}"
echo "    docker logs codeck -f        — view logs"
echo "    docker restart codeck        — restart"
echo "    docker stop codeck           — stop"
echo "    docker start codeck          — start"
echo ""
echo -e "  ${BOLD}Update:${NC}"
echo "    curl -fsSL https://codeck.xyz/install | bash"
echo ""
if [[ -n "$CODECK_MEMORY" || -n "$CODECK_CPUS" ]]; then
  echo -e "  ${BOLD}Resources:${NC}"
  [[ -n "$CODECK_MEMORY" ]] && echo "    Memory: ${CODECK_MEMORY}"
  [[ -n "$CODECK_CPUS" ]] && echo "    CPUs: ${CODECK_CPUS}"
  echo ""
fi
echo -e "  ${BOLD}Data (persists across updates):${NC}"
echo "    Workspace:  codeck-workspace"
echo "    Claude:     codeck-claude"
echo "    SSH keys:   codeck-ssh"
echo "    GitHub:     codeck-gh"
echo ""
echo -e "  ${DIM}Installer v${VERSION}${NC}"
echo ""
}
main "$@"
