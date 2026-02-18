#!/usr/bin/env bash
set -euo pipefail

# Codeck Development Setup
# For developers who clone the repo and run directly from it.
#
# Prerequisites: clone the repo first, then run this from inside it:
#   git clone https://github.com/cyphercr0w/codeck.git /opt/codeck
#   cd /opt/codeck
#   sudo bash scripts/dev-setup.sh
#
# This installs system dependencies and configures systemd to run
# Codeck directly from the cloned repo. No copies, no syncing.
# After code changes: npm run build && sudo systemctl restart codeck

NODE_MAJOR=22
CODECK_USER="codeck"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
error(){ echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }
step() { echo -e "\n${CYAN}── $* ──${NC}"; }

CODECK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ─── Pre-flight ──────────────────────────────────────────────────────

step "Pre-flight"

[[ "$(uname -s)" == "Linux" ]] || error "Linux required"
[[ "$EUID" -eq 0 ]] || error "Run as root: sudo bash scripts/dev-setup.sh"
[[ -f "$CODECK_DIR/package.json" ]] || error "Run from inside the codeck repo"
command -v systemctl &>/dev/null || error "systemd required"

log "Repo at: $CODECK_DIR"

# ─── System deps ─────────────────────────────────────────────────────

step "System dependencies"

apt-get update -qq
apt-get install -y -qq curl git build-essential python3 rsync >/dev/null
log "Done"

# ─── Node.js ─────────────────────────────────────────────────────────

step "Node.js $NODE_MAJOR"

if command -v node &>/dev/null; then
  ver=$(node -v | sed 's/v//' | cut -d. -f1)
  if [[ "$ver" -ge "$NODE_MAJOR" ]]; then
    log "Node.js $(node -v) OK"
  else
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
    log "Node.js $(node -v) installed"
  fi
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  log "Node.js $(node -v) installed"
fi

# ─── Docker ──────────────────────────────────────────────────────────

step "Docker"

if command -v docker &>/dev/null; then
  log "Docker already installed"
else
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
  systemctl enable docker >/dev/null
  systemctl start docker
  log "Docker installed"
fi

# ─── Claude CLI ──────────────────────────────────────────────────────

step "Claude Code CLI"

if command -v claude &>/dev/null; then
  log "Already installed"
else
  log "Installing (takes a minute)..."
  npm install -g @anthropic-ai/claude-code 2>/dev/null
  log "Done"
fi

# ─── User ────────────────────────────────────────────────────────────

step "User: $CODECK_USER"

if ! id "$CODECK_USER" &>/dev/null; then
  useradd -r -m -s /bin/bash "$CODECK_USER"
  log "Created"
fi

usermod -aG docker "$CODECK_USER" 2>/dev/null || true

CODECK_HOME="/home/$CODECK_USER"
for dir in "$CODECK_HOME/workspace" "$CODECK_HOME/.codeck" "$CODECK_HOME/.claude" "$CODECK_HOME/.ssh"; do
  mkdir -p "$dir"
done
chmod 700 "$CODECK_HOME/.codeck" "$CODECK_HOME/.claude" "$CODECK_HOME/.ssh"
chown -R "$CODECK_USER:$CODECK_USER" "$CODECK_HOME"

# Sudoers for self-deploy (restart service after rebuilds)
cat > /etc/sudoers.d/codeck <<'SUDOERS'
codeck ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart codeck
codeck ALL=(ALL) NOPASSWD: /usr/bin/systemctl stop codeck
codeck ALL=(ALL) NOPASSWD: /usr/bin/systemctl start codeck
SUDOERS
chmod 440 /etc/sudoers.d/codeck
log "User ready, sudoers configured"

# ─── Build ───────────────────────────────────────────────────────────

step "Install & build"

cd "$CODECK_DIR"
chown -R "$CODECK_USER:$CODECK_USER" "$CODECK_DIR"

sudo -u "$CODECK_USER" npm ci 2>&1 | tail -3
sudo -u "$CODECK_USER" npm run build 2>&1 | tail -5
log "Built"

# ─── Systemd ─────────────────────────────────────────────────────────

step "Systemd service"

cat > /etc/systemd/system/codeck.service <<UNIT
[Unit]
Description=Codeck - Claude Code Sandbox
After=network.target
Wants=docker.service

[Service]
Type=simple
User=$CODECK_USER
Group=$CODECK_USER
WorkingDirectory=$CODECK_DIR

Environment="PATH=/usr/local/bin:/usr/bin:/bin"
Environment="NODE_ENV=production"
Environment="CODECK_PORT=80"
Environment="WORKSPACE=$CODECK_HOME/workspace"
Environment="CODECK_DIR=$CODECK_HOME/.codeck"
Environment="HOME=$CODECK_HOME"

ExecStart=/usr/bin/node $CODECK_DIR/dist/index.js --web
Restart=always
RestartSec=10

CPUQuota=200%
MemoryMax=4G
NoNewPrivileges=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable codeck >/dev/null 2>&1
systemctl start codeck
log "Service started"

sleep 2
systemctl is-active --quiet codeck && log "Running!" || warn "Check: journalctl -u codeck -n 30"

# ─── Symlink repo into workspace ──────────────────────────────────────

WORKSPACE_LINK="$CODECK_HOME/workspace/codeck"
if [[ ! -e "$WORKSPACE_LINK" ]]; then
  ln -s "$CODECK_DIR" "$WORKSPACE_LINK"
  chown -h "$CODECK_USER:$CODECK_USER" "$WORKSPACE_LINK"
  log "Symlinked $CODECK_DIR → $WORKSPACE_LINK"
else
  log "Workspace link already exists: $WORKSPACE_LINK"
fi

# ─── Firewall ────────────────────────────────────────────────────────

if command -v ufw &>/dev/null; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
fi

# ─── Done ─────────────────────────────────────────────────────────────

PUBLIC_IP=$(curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  Codeck dev setup complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo -e "  Open: ${CYAN}http://${PUBLIC_IP}${NC}"
echo ""
echo "  After code changes:"
echo "    cd $CODECK_DIR"
echo "    npm run build && sudo systemctl restart codeck"
echo ""
echo "  Logs:  journalctl -u codeck -f"
echo ""
