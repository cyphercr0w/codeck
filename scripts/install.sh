#!/usr/bin/env bash
set -euo pipefail

# Codeck Installation Script
# Clones the repo, builds from source, and installs as a systemd service.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/cyphercr0w/codeck/main/scripts/install.sh | sudo bash
#
# Or manually:
#   sudo bash install.sh

CODECK_REPO="https://github.com/cyphercr0w/codeck.git"
CODECK_BRANCH="${CODECK_BRANCH:-main}"
CODECK_DIR="/opt/codeck"
CODECK_USER="codeck"
NODE_MAJOR=22

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${GREEN}[+]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }
step()  { echo -e "\n${CYAN}── $* ──${NC}"; }

# ─── Pre-flight checks ──────────────────────────────────────────────

step "Pre-flight checks"

[[ "$(uname -s)" == "Linux" ]] || error "Linux required. Detected: $(uname -s)"
log "OS: Linux ($(uname -r))"

[[ "$EUID" -eq 0 ]] || error "Run as root: sudo bash install.sh"
log "Running as root"

command -v systemctl &>/dev/null || error "systemd not found"
log "systemd detected"

if command -v apt-get &>/dev/null; then
  PKG_MANAGER="apt"
elif command -v dnf &>/dev/null; then
  PKG_MANAGER="dnf"
elif command -v yum &>/dev/null; then
  PKG_MANAGER="yum"
else
  error "No supported package manager (apt, dnf, yum)"
fi
log "Package manager: $PKG_MANAGER"

# ─── System dependencies ────────────────────────────────────────────

step "System dependencies"

case "$PKG_MANAGER" in
  apt)
    apt-get update -qq
    apt-get install -y -qq curl git build-essential python3 rsync >/dev/null
    ;;
  dnf|yum)
    $PKG_MANAGER install -y -q curl git gcc gcc-c++ make python3 rsync >/dev/null
    ;;
esac
log "Installed: curl, git, build-essential, python3, rsync"

# ─── Node.js ────────────────────────────────────────────────────────

step "Node.js $NODE_MAJOR"

if command -v node &>/dev/null; then
  ver=$(node -v | sed 's/v//' | cut -d. -f1)
  if [[ "$ver" -ge "$NODE_MAJOR" ]]; then
    log "Node.js $(node -v) already installed"
  else
    warn "Node.js $(node -v) too old, upgrading..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
    log "Node.js $(node -v) installed"
  fi
else
  log "Installing Node.js $NODE_MAJOR..."
  case "$PKG_MANAGER" in
    apt)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
      apt-get install -y -qq nodejs >/dev/null
      ;;
    dnf|yum)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
      $PKG_MANAGER install -y -q nodejs >/dev/null
      ;;
  esac
  log "Node.js $(node -v) installed"
fi

# ─── Docker (for Claude to use) ─────────────────────────────────────

step "Docker"

if command -v docker &>/dev/null; then
  log "Docker already installed: $(docker --version)"
else
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
  systemctl enable docker >/dev/null
  systemctl start docker
  log "Docker installed: $(docker --version)"
fi

# ─── Claude Code CLI ────────────────────────────────────────────────

step "Claude Code CLI"

if command -v claude &>/dev/null; then
  log "Claude CLI already installed: $(claude --version 2>/dev/null || echo 'unknown')"
else
  log "Installing Claude Code CLI (this takes a minute)..."
  npm install -g @anthropic-ai/claude-code 2>/dev/null
  log "Claude CLI installed: $(claude --version 2>/dev/null || echo 'ok')"
fi

# ─── User and directories ───────────────────────────────────────────

step "User and directories"

if id "$CODECK_USER" &>/dev/null; then
  log "User '$CODECK_USER' already exists"
else
  useradd -r -m -s /bin/bash "$CODECK_USER"
  log "User '$CODECK_USER' created"
fi

usermod -aG docker "$CODECK_USER" 2>/dev/null || true
log "User '$CODECK_USER' in docker group"

CODECK_HOME="/home/$CODECK_USER"
for dir in "$CODECK_HOME/workspace" "$CODECK_HOME/.codeck" "$CODECK_HOME/.claude" "$CODECK_HOME/.ssh"; do
  mkdir -p "$dir"
done
chmod 700 "$CODECK_HOME/.codeck" "$CODECK_HOME/.claude" "$CODECK_HOME/.ssh"
chown -R "$CODECK_USER:$CODECK_USER" "$CODECK_HOME"
log "Directories ready under $CODECK_HOME"

# Sudoers: allow codeck user to restart the service and sync files (for self-deploy)
SUDOERS_FILE="/etc/sudoers.d/codeck"
cat > "$SUDOERS_FILE" <<'SUDOERS'
# Codeck self-deploy: restart service, sync files, fix ownership
codeck ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart codeck
codeck ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop codeck
codeck ALL=(ALL) NOPASSWD: /usr/bin/systemctl start codeck
codeck ALL=(ALL) NOPASSWD: /usr/bin/rsync *
codeck ALL=(ALL) NOPASSWD: /usr/bin/cp *
codeck ALL=(ALL) NOPASSWD: /usr/bin/chown *
SUDOERS
chmod 440 "$SUDOERS_FILE"
log "Sudoers configured (self-deploy permissions)"

# ─── Clone and build Codeck ─────────────────────────────────────────

step "Codeck (clone + build)"

if [[ -d "$CODECK_DIR/.git" ]]; then
  log "Repo already exists, pulling latest..."
  cd "$CODECK_DIR"
  git fetch origin
  git reset --hard "origin/$CODECK_BRANCH"
else
  log "Cloning $CODECK_REPO ($CODECK_BRANCH)..."
  rm -rf "$CODECK_DIR"
  git clone --branch "$CODECK_BRANCH" --depth 1 "$CODECK_REPO" "$CODECK_DIR"
fi

cd "$CODECK_DIR"

log "Installing dependencies..."
npm ci 2>&1 | tail -3

log "Building (frontend + backend)..."
npm run build 2>&1 | tail -5

chown -R "$CODECK_USER:$CODECK_USER" "$CODECK_DIR"
log "Codeck built at $CODECK_DIR"

# ─── Systemd service ────────────────────────────────────────────────

step "Systemd service"

cat > /etc/systemd/system/codeck.service <<'UNIT'
[Unit]
Description=Codeck - Claude Code Sandbox
After=network.target
Wants=docker.service

[Service]
Type=simple
User=codeck
Group=codeck
WorkingDirectory=/opt/codeck

Environment="PATH=/usr/local/bin:/usr/bin:/bin"
Environment="NODE_ENV=production"
Environment="CODECK_PORT=80"
Environment="WORKSPACE=/home/codeck/workspace"
Environment="CODECK_DIR=/home/codeck/.codeck"
Environment="HOME=/home/codeck"

ExecStart=/usr/bin/node /opt/codeck/dist/index.js --web
Restart=always
RestartSec=10

# Resource limits
CPUQuota=200%
MemoryMax=4G

# Security
NoNewPrivileges=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable codeck >/dev/null 2>&1
systemctl start codeck
log "Service installed and started"

sleep 2
if systemctl is-active --quiet codeck; then
  log "Service is running!"
else
  warn "Service may have failed. Check: journalctl -u codeck -n 30"
fi

# ─── Firewall ───────────────────────────────────────────────────────

step "Firewall"

if command -v ufw &>/dev/null; then
  ufw allow 80/tcp >/dev/null 2>&1 && log "UFW: port 80 allowed" || true
elif command -v firewall-cmd &>/dev/null; then
  firewall-cmd --permanent --add-port=80/tcp >/dev/null 2>&1
  firewall-cmd --reload >/dev/null 2>&1
  log "firewalld: port 80 allowed"
else
  log "No firewall detected — port 80 should be open"
fi

# ─── Done ────────────────────────────────────────────────────────────

PUBLIC_IP=$(curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  Codeck installed successfully!${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo -e "  Open: ${CYAN}http://${PUBLIC_IP}${NC}"
echo ""
echo "  Commands:"
echo "    systemctl status codeck     — status"
echo "    systemctl restart codeck    — restart"
echo "    journalctl -u codeck -f     — logs"
echo ""
echo "  Update:"
echo "    cd /opt/codeck && sudo git pull && sudo npm ci && sudo npm run build && sudo systemctl restart codeck"
echo ""
echo "  Paths:"
echo "    /opt/codeck/                — app code"
echo "    /home/codeck/workspace/     — workspace"
echo "    /home/codeck/.codeck/       — config & memory"
echo ""
