#!/usr/bin/env bash
set -euo pipefail

# Codeck Self-Hosted Installer
#
# One command to install Codeck on any Linux VPS or macOS machine.
# Pulls a pre-built Docker image — no compilation, no Node.js required.
#
# Usage:
#   curl -fsSL https://codeck.xyz/install | bash

CODECK_IMAGE="${CODECK_IMAGE:-ghcr.io/cyphercr0w/codeck:latest}"
CODECK_PORT="${CODECK_PORT:-8080}"
CONTAINER_NAME="codeck"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[x]${NC} $*" >&2; }
die()  { err "$*"; exit 1; }

# ─── Auto-elevate with sudo if needed ─────────────────────────────────

if [[ "$EUID" -ne 0 ]]; then
  if command -v sudo &>/dev/null; then
    exec sudo bash "$0" "$@"
  fi
  # Not root and no sudo — try anyway, Docker might work without root
fi

# ─── Detect OS ─────────────────────────────────────────────────────────

OS="$(uname -s)"
case "$OS" in
  Linux)  log "OS: Linux" ;;
  Darwin) log "OS: macOS" ;;
  *)      die "Unsupported OS: $OS. Codeck requires Linux or macOS." ;;
esac

# ─── Install Docker if missing ─────────────────────────────────────────

if ! command -v docker &>/dev/null; then
  log "Docker not found — installing..."
  if [[ "$OS" == "Linux" ]]; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker 2>/dev/null || true
    systemctl start docker 2>/dev/null || true
  elif [[ "$OS" == "Darwin" ]]; then
    die "Docker not installed. Install Docker Desktop from https://docker.com/products/docker-desktop and re-run this script."
  fi
fi

# Verify Docker is running
if ! docker info &>/dev/null 2>&1; then
  if [[ "$OS" == "Linux" ]]; then
    systemctl start docker 2>/dev/null || true
    sleep 2
  fi
  docker info &>/dev/null 2>&1 || die "Docker is installed but not running. Start Docker and re-run this script."
fi

log "Docker: $(docker --version | head -1)"

# ─── Stop existing container if running ────────────────────────────────

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  warn "Existing '${CONTAINER_NAME}' container found — stopping..."
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true
fi

# ─── Pull image ────────────────────────────────────────────────────────

log "Pulling Codeck image..."
docker pull "$CODECK_IMAGE"

# ─── Run container ─────────────────────────────────────────────────────

log "Starting Codeck..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --init \
  -p "${CODECK_PORT}:80" \
  -v codeck-workspace:/workspace \
  -v codeck-claude:/root/.claude \
  -v codeck-ssh:/root/.ssh \
  -v codeck-gh:/root/.config/gh \
  --cap-drop ALL \
  --cap-add CHOWN \
  --cap-add SETUID \
  --cap-add SETGID \
  --cap-add NET_BIND_SERVICE \
  --cap-add KILL \
  --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges:true \
  --stop-timeout 30 \
  "$CODECK_IMAGE" --web

# ─── Wait for healthy ──────────────────────────────────────────────────

log "Waiting for Codeck to start..."
for i in $(seq 1 30); do
  if docker exec "$CONTAINER_NAME" curl -sf http://localhost:80/api/status &>/dev/null; then
    break
  fi
  sleep 1
done

if ! docker exec "$CONTAINER_NAME" curl -sf http://localhost:80/api/status &>/dev/null; then
  warn "Codeck is starting but not healthy yet. Check: docker logs codeck"
fi

# ─── Firewall ──────────────────────────────────────────────────────────

if command -v ufw &>/dev/null; then
  ufw allow "${CODECK_PORT}/tcp" >/dev/null 2>&1 && log "UFW: port ${CODECK_PORT} allowed" || true
elif command -v firewall-cmd &>/dev/null; then
  firewall-cmd --permanent --add-port="${CODECK_PORT}/tcp" >/dev/null 2>&1
  firewall-cmd --reload >/dev/null 2>&1
  log "firewalld: port ${CODECK_PORT} allowed"
fi

# ─── Done ──────────────────────────────────────────────────────────────

PUBLIC_IP=$(curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

echo ""
echo -e "${GREEN}${BOLD}════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  Codeck installed successfully!${NC}"
echo -e "${GREEN}${BOLD}════════════════════════════════════════${NC}"
echo ""
echo -e "  Open: ${CYAN}http://${PUBLIC_IP}:${CODECK_PORT}${NC}"
echo ""
echo -e "  ${BOLD}Commands:${NC}"
echo "    docker logs codeck -f        — view logs"
echo "    docker restart codeck        — restart"
echo "    docker stop codeck           — stop"
echo "    docker start codeck          — start"
echo ""
echo -e "  ${BOLD}Update:${NC}"
echo "    docker pull ${CODECK_IMAGE}"
echo "    docker stop codeck && docker rm codeck"
echo "    # Re-run this script"
echo ""
echo -e "  ${BOLD}Data:${NC}"
echo "    Workspace:  codeck-workspace volume"
echo "    Claude CLI: codeck-claude volume"
echo "    SSH keys:   codeck-ssh volume"
echo ""
echo -e "  ${BOLD}SSL (optional):${NC}"
echo "    Put nginx in front with certbot for HTTPS."
echo ""
