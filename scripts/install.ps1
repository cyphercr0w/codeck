# Codeck Self-Hosted Installer for Windows
#
# Usage:
#   irm https://codeck.xyz/install.ps1 | iex

$ErrorActionPreference = "Stop"

$CODECK_IMAGE = if ($env:CODECK_IMAGE) { $env:CODECK_IMAGE } else { "ghcr.io/cyphercr0w/codeck:latest" }
$CODECK_PORT = if ($env:CODECK_PORT) { $env:CODECK_PORT } else { "8080" }
$CONTAINER_NAME = "codeck"

function Log($msg) { Write-Host "[+] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Err($msg) { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }

# ─── Check Docker ──────────────────────────────────────────────────────

Log "Checking Docker..."
try {
    $null = docker info 2>$null
} catch {
    Err "Docker is not installed or not running. Install Docker Desktop from https://docker.com/products/docker-desktop and re-run this script."
}
Log "Docker: $(docker --version)"

# ─── Stop existing container ───────────────────────────────────────────

$existing = docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $CONTAINER_NAME }
if ($existing) {
    Warn "Existing '$CONTAINER_NAME' container found — stopping..."
    docker stop $CONTAINER_NAME 2>$null | Out-Null
    docker rm $CONTAINER_NAME 2>$null | Out-Null
}

# ─── Pull image ────────────────────────────────────────────────────────

Log "Pulling Codeck image..."
docker pull $CODECK_IMAGE
if ($LASTEXITCODE -ne 0) { Err "Failed to pull image. Check your internet connection." }

# ─── Run container ─────────────────────────────────────────────────────

Log "Starting Codeck..."
docker run -d `
    --name $CONTAINER_NAME `
    --restart unless-stopped `
    --init `
    -p "${CODECK_PORT}:80" `
    -v codeck-workspace:/workspace `
    -v codeck-claude:/root/.claude `
    -v codeck-ssh:/root/.ssh `
    -v codeck-gh:/root/.config/gh `
    --cap-drop ALL `
    --cap-add CHOWN `
    --cap-add SETUID `
    --cap-add SETGID `
    --cap-add NET_BIND_SERVICE `
    --cap-add KILL `
    --cap-add DAC_OVERRIDE `
    --security-opt no-new-privileges:true `
    --stop-timeout 30 `
    $CODECK_IMAGE --web

if ($LASTEXITCODE -ne 0) { Err "Failed to start container." }

# ─── Wait for healthy ──────────────────────────────────────────────────

Log "Waiting for Codeck to start..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $result = docker exec $CONTAINER_NAME curl -sf http://localhost:80/api/status 2>$null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 1
}

if (-not $ready) {
    Warn "Codeck is starting but not healthy yet. Check: docker logs codeck"
}

# ─── Done ──────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "════════════════════════════════════════" -ForegroundColor Green
Write-Host "  Codeck installed successfully!" -ForegroundColor Green
Write-Host "════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "  Open: " -NoNewline; Write-Host "http://localhost:$CODECK_PORT" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Commands:" -ForegroundColor White
Write-Host "    docker logs codeck -f        — view logs"
Write-Host "    docker restart codeck        — restart"
Write-Host "    docker stop codeck           — stop"
Write-Host "    docker start codeck          — start"
Write-Host ""
Write-Host "  Update:" -ForegroundColor White
Write-Host "    docker pull $CODECK_IMAGE"
Write-Host "    docker stop codeck; docker rm codeck"
Write-Host "    # Re-run this script"
Write-Host ""
