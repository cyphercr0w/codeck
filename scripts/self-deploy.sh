#!/usr/bin/env bash
set -euo pipefail

# Self-deploy: build from workspace clone, copy to /opt/codeck, restart service.
# Run this from the workspace codeck repo (e.g., /home/codeck/workspace/codeck).
#
# Usage:
#   bash scripts/self-deploy.sh          # full build + deploy
#   bash scripts/self-deploy.sh --quick  # skip npm ci, just rebuild + deploy

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
die()  { echo -e "${RED}[deploy]${NC} $*" >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="/opt/codeck"
QUICK=false

[[ "${1:-}" == "--quick" ]] && QUICK=true

cd "$REPO_DIR"

# Sanity checks
[[ -f package.json ]] || die "Not in a codeck repo (no package.json)"
[[ -d .git ]] || die "Not a git repo"

# ─── Step 1: Check for uncommitted changes ──────────────────────────

if [[ -n "$(git status --porcelain)" ]]; then
  warn "You have uncommitted changes. Commit first to avoid losing work."
  warn "(The service restart will kill this terminal session)"
  echo ""
  git status --short
  echo ""
  read -p "Deploy anyway? [y/N] " -n 1 -r
  echo ""
  [[ $REPLY =~ ^[Yy]$ ]] || exit 0
fi

# ─── Step 2: Install dependencies ───────────────────────────────────

if [[ "$QUICK" == false ]]; then
  log "Installing dependencies..."
  npm ci --omit=dev 2>&1 | tail -3
fi

# ─── Step 3: Build ──────────────────────────────────────────────────

log "Building frontend + backend..."
npm run build 2>&1 | tail -5
log "Build complete"

# ─── Step 4: Sync to /opt/codeck ────────────────────────────────────

log "Syncing to $INSTALL_DIR..."

# Copy built output and package files
sudo rsync -a --delete dist/ "$INSTALL_DIR/dist/"
sudo cp package.json package-lock.json "$INSTALL_DIR/"

# Copy templates (may have changed)
sudo rsync -a --delete src/templates/ "$INSTALL_DIR/dist/templates/"

# Sync node_modules only if full build (not --quick)
if [[ "$QUICK" == false ]]; then
  sudo rsync -a --delete node_modules/ "$INSTALL_DIR/node_modules/"
fi

# Fix ownership
sudo chown -R codeck:codeck "$INSTALL_DIR"

log "Files synced"

# ─── Step 5: Restart service ────────────────────────────────────────

log "Restarting codeck service..."
log ""
log "  ⚠  This will kill your current terminal session."
log "  ⚠  The frontend will reconnect automatically."
log ""

# Use nohup + disown so the restart doesn't get killed with us
nohup sudo systemctl restart codeck >/dev/null 2>&1 &
disown

log "Service restart triggered. Goodbye!"
