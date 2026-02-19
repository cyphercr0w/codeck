#!/usr/bin/env bash
set -euo pipefail

# Self-deploy: rebuild and restart the live Codeck service.
# Run from the repo root (which IS the live installation).
#
# Usage:
#   bash scripts/self-deploy.sh

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."

log "Building TypeScript..."
npm run build 2>&1 | tail -5

log "Building Docker image..."
docker build -t codeck -f docker/Dockerfile . 2>&1 | tail -5

log "Restarting service (your session will die)..."
nohup sudo systemctl restart codeck >/dev/null 2>&1 &
disown

log "Done. Frontend will auto-reconnect."
