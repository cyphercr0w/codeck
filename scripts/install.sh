#!/usr/bin/env bash
set -euo pipefail

# Codeck Installation Script
# Installs Codeck as a systemd service on Linux VPS

CODECK_VERSION="${CODECK_VERSION:-latest}"
CODECK_DIR="/opt/codeck"
CODECK_USER="codeck"
NODE_MAJOR=22

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[+]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ─── Part 1: Pre-flight checks ──────────────────────────────────────

# 1. OS detection — Linux only
if [[ "$(uname -s)" != "Linux" ]]; then
  error "Codeck systemd deployment only supports Linux. Detected: $(uname -s)"
fi
log "OS: Linux ($(uname -r))"

# 2. Root check
if [[ "$EUID" -ne 0 ]]; then
  error "This script must be run as root. Use: sudo bash install.sh"
fi
log "Running as root"

# 3. Systemd check
if ! command -v systemctl &>/dev/null; then
  error "systemd is required but not found. This script requires a systemd-based Linux distribution."
fi
log "systemd detected"

# 4. Distro detection (for package manager)
if command -v apt-get &>/dev/null; then
  PKG_MANAGER="apt"
elif command -v dnf &>/dev/null; then
  PKG_MANAGER="dnf"
elif command -v yum &>/dev/null; then
  PKG_MANAGER="yum"
else
  error "No supported package manager found (apt, dnf, yum)"
fi
log "Package manager: $PKG_MANAGER"

# ─── Part 1: Dependency installation ────────────────────────────────

# 5. Install Node.js 22+
install_nodejs() {
  if command -v node &>/dev/null; then
    local current_version
    current_version=$(node -v | sed 's/v//' | cut -d. -f1)
    if [[ "$current_version" -ge "$NODE_MAJOR" ]]; then
      log "Node.js $(node -v) already installed (>= $NODE_MAJOR)"
      return
    fi
    warn "Node.js $(node -v) found but < $NODE_MAJOR, upgrading..."
  fi

  log "Installing Node.js $NODE_MAJOR..."
  case "$PKG_MANAGER" in
    apt)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
      apt-get install -y nodejs
      ;;
    dnf|yum)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
      $PKG_MANAGER install -y nodejs
      ;;
  esac
  log "Node.js $(node -v) installed"
}

# 6. Install Docker
install_docker() {
  if command -v docker &>/dev/null; then
    log "Docker already installed: $(docker --version)"
    return
  fi

  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  log "Docker installed: $(docker --version)"
}

install_nodejs
install_docker

# ─── Part 2: Claude CLI ─────────────────────────────────────────────

# 7. Install Claude Code CLI
if command -v claude &>/dev/null; then
  log "Claude CLI already installed: $(claude --version 2>/dev/null || echo 'unknown version')"
else
  log "Installing Claude Code CLI..."
  npm install -g @anthropic-ai/claude-code
  log "Claude CLI installed"
fi

# ─── Part 2: User and directory setup ───────────────────────────────

# 8. Create codeck system user
if id "$CODECK_USER" &>/dev/null; then
  log "User '$CODECK_USER' already exists"
else
  log "Creating user '$CODECK_USER'..."
  useradd -r -m -s /bin/bash "$CODECK_USER"
  log "User '$CODECK_USER' created"
fi

# Add to docker group so Claude can use Docker natively
usermod -aG docker "$CODECK_USER"
log "User '$CODECK_USER' added to docker group"

# 9. Create workspace and config directories
CODECK_HOME="/home/$CODECK_USER"
DIRS=(
  "$CODECK_HOME/workspace"
  "$CODECK_HOME/.codeck"
  "$CODECK_HOME/.claude"
  "$CODECK_HOME/.ssh"
)

for dir in "${DIRS[@]}"; do
  mkdir -p "$dir"
done
chown -R "$CODECK_USER:$CODECK_USER" "$CODECK_HOME"
log "Directories created under $CODECK_HOME"

# ─── Part 2: Download and install Codeck ─────────────────────────────

# 10. Install Codeck application
mkdir -p "$CODECK_DIR"

if [[ "$CODECK_VERSION" == "latest" ]]; then
  DOWNLOAD_URL="https://github.com/codeck-sh/codeck/releases/latest/download/codeck.tar.gz"
else
  DOWNLOAD_URL="https://github.com/codeck-sh/codeck/releases/download/v${CODECK_VERSION}/codeck.tar.gz"
fi

log "Downloading Codeck ($CODECK_VERSION)..."
curl -fsSL "$DOWNLOAD_URL" -o /tmp/codeck.tar.gz
tar xzf /tmp/codeck.tar.gz -C "$CODECK_DIR"
rm -f /tmp/codeck.tar.gz

cd "$CODECK_DIR"
npm install --production
log "Codeck installed to $CODECK_DIR"

# ─── Part 2: Systemd service setup ──────────────────────────────────

# 11. Install and enable systemd service
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/codeck.service"

if [[ -f "$SERVICE_FILE" ]]; then
  cp "$SERVICE_FILE" /etc/systemd/system/codeck.service
else
  # Fallback: use the one bundled in the installed package
  cp "$CODECK_DIR/scripts/codeck.service" /etc/systemd/system/codeck.service
fi

systemctl daemon-reload
systemctl enable codeck
systemctl start codeck
log "Systemd service installed and started"

# ─── Done ────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Codeck installed successfully!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "  Access at: http://localhost"
echo ""
echo "  Useful commands:"
echo "    systemctl status codeck    — check service status"
echo "    systemctl restart codeck   — restart service"
echo "    journalctl -u codeck -f    — follow logs"
echo ""
