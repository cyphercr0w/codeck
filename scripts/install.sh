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

# Detect WSL — systemd support is limited; warn before proceeding
if grep -qiE "(microsoft|wsl)" /proc/version 2>/dev/null; then
  echo ""
  echo -e "${YELLOW}┌──────────────────────────────────────────────────────────┐${NC}"
  echo -e "${YELLOW}│                  ⚠  WSL DETECTED                        │${NC}"
  echo -e "${YELLOW}├──────────────────────────────────────────────────────────┤${NC}"
  echo -e "${YELLOW}│  You appear to be running inside Windows Subsystem for   │${NC}"
  echo -e "${YELLOW}│  Linux (WSL). systemd support in WSL is limited and      │${NC}"
  echo -e "${YELLOW}│  may not work correctly.                                  │${NC}"
  echo -e "${YELLOW}│                                                           │${NC}"
  echo -e "${YELLOW}│  Recommended: use Docker Desktop on Windows instead.      │${NC}"
  echo -e "${YELLOW}│  Install the Codeck CLI and run: codeck init              │${NC}"
  echo -e "${YELLOW}└──────────────────────────────────────────────────────────┘${NC}"
  echo ""
  if [ -t 0 ]; then
    read -r -p "Continue anyway? [y/N] " _wsl_confirm
    case "$_wsl_confirm" in
      [yY][eE][sS]|[yY]) : ;;
      *)
        echo -e "${RED}Aborted.${NC}"
        exit 1
        ;;
    esac
  else
    echo -e "${YELLOW}[!]${NC} Running non-interactively. Continuing in 10 seconds — press Ctrl+C to abort."
    for i in 10 9 8 7 6 5 4 3 2 1; do
      printf "\r    %d... " "$i"
      sleep 1
    done
    echo ""
  fi
  echo ""
fi

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

# ─── Isolation warning ──────────────────────────────────────────────

echo ""
echo -e "${YELLOW}┌──────────────────────────────────────────────────────────┐${NC}"
echo -e "${YELLOW}│                  ⚠  SECURITY WARNING                    │${NC}"
echo -e "${YELLOW}├──────────────────────────────────────────────────────────┤${NC}"
echo -e "${YELLOW}│  This installs Codeck directly on the host without       │${NC}"
echo -e "${YELLOW}│  container isolation.                                     │${NC}"
echo -e "${YELLOW}│                                                           │${NC}"
echo -e "${YELLOW}│  The agent (Claude Code) will run as the 'codeck' user   │${NC}"
echo -e "${YELLOW}│  and has full access to:                                  │${NC}"
echo -e "${YELLOW}│    • the host filesystem                                  │${NC}"
echo -e "${YELLOW}│    • network interfaces                                   │${NC}"
echo -e "${YELLOW}│    • the ability to run arbitrary commands                │${NC}"
echo -e "${YELLOW}│                                                           │${NC}"
echo -e "${YELLOW}│  Recommended: run on a dedicated VPS, not your personal  │${NC}"
echo -e "${YELLOW}│  workstation. For local use, prefer Docker mode instead.  │${NC}"
echo -e "${YELLOW}└──────────────────────────────────────────────────────────┘${NC}"
echo ""

if [ -t 0 ]; then
  # Interactive shell — require explicit confirmation
  read -r -p "Continue anyway? [y/N] " _confirm
  case "$_confirm" in
    [yY][eE][sS]|[yY]) : ;;
    *)
      echo -e "${RED}Aborted.${NC}"
      exit 1
      ;;
  esac
else
  # Piped execution (curl | bash) — show countdown so user can Ctrl+C
  echo -e "${YELLOW}[!]${NC} Running non-interactively. Continuing in 10 seconds — press Ctrl+C to abort."
  for i in 10 9 8 7 6 5 4 3 2 1; do
    printf "\r    %d... " "$i"
    sleep 1
  done
  echo ""
fi

echo ""

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

# ─── GitHub CLI ─────────────────────────────────────────────────────

step "GitHub CLI (gh)"

if command -v gh &>/dev/null; then
  log "GitHub CLI already installed: $(gh --version | head -1)"
else
  log "Installing GitHub CLI..."
  case "$PKG_MANAGER" in
    apt)
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list
      apt-get update -qq
      apt-get install -y -qq gh >/dev/null
      ;;
    dnf|yum)
      $PKG_MANAGER install -y -q 'dnf-command(config-manager)' 2>/dev/null || true
      $PKG_MANAGER config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo 2>/dev/null || true
      $PKG_MANAGER install -y -q gh >/dev/null
      ;;
  esac
  log "GitHub CLI installed: $(gh --version | head -1)"
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

# Create /workspace symlink so agent memory paths (/workspace/.codeck/...) resolve correctly
# on non-Docker deployments where the workspace lives at a different absolute path.
if [ ! -e /workspace ]; then
  ln -sf "$CODECK_HOME/workspace" /workspace
  log "/workspace → $CODECK_HOME/workspace symlink created"
elif [ -L /workspace ]; then
  log "/workspace symlink already exists ($(readlink /workspace))"
else
  log "WARNING: /workspace exists as a non-symlink — skipping (may be Docker volume)"
fi

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

# ─── Git identity ───────────────────────────────────────────────────

step "Git identity"

# Set git committer name for the codeck user (displayed on GitHub commits).
# The email should be configured after gh auth login to link commits to a GitHub avatar.
sudo -u "$CODECK_USER" git config --global user.name "Codeck"
log "Git user.name = Codeck (set for $CODECK_USER)"

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
