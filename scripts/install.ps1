# ═══════════════════════════════════════════════════════════════════════
# Codeck Installer & Updater for Windows
#
# Handles fresh install, updates, and resource changes.
# Config is stored as Docker container labels — no host-side state files.
#
# Usage:
#   irm https://codeck.xyz/install.ps1 | iex                          # interactive
#   $env:CODECK_PORT=3000; irm https://codeck.xyz/install.ps1 | iex   # non-interactive
#
# Environment overrides (skip prompts):
#   CODECK_PORT     — host port (default: 8080)
#   CODECK_MEMORY   — memory limit, e.g. "4g" (default: unlimited)
#   CODECK_CPUS     — CPU limit, e.g. "2" (default: unlimited)
#   CODECK_IMAGE    — Docker image (default: ghcr.io/cyphercr0w/codeck:latest)
#   CODECK_NAME     — container name (default: codeck)
# ═══════════════════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"

$VERSION = "1.0.0"
$DEFAULT_IMAGE = "ghcr.io/cyphercr0w/codeck:latest"
$DEFAULT_PORT = "8080"
$DEFAULT_NAME = "codeck"

# ─── Helpers ──────────────────────────────────────────────────────────

function Log($msg)  { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  › $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Err($msg)  { Write-Host "  ✗ $msg" -ForegroundColor Red }
function Die($msg)  { Err $msg; exit 1 }

function Ask($varName, $prompt, $default) {
    $current = [Environment]::GetEnvironmentVariable($varName)
    if ($current) {
        Set-Variable -Name $varName -Value $current -Scope Script
        Write-Host "  $prompt [$current]" -ForegroundColor DarkGray
        return
    }
    $value = Read-Host "  $prompt [$default]"
    if ([string]::IsNullOrWhiteSpace($value)) { $value = $default }
    Set-Variable -Name $varName -Value $value -Scope Script
}

# ─── Header ──────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ╔═══════════════════════════════════╗" -ForegroundColor White
Write-Host "  ║         Codeck Installer           ║" -ForegroundColor Cyan
Write-Host "  ╚═══════════════════════════════════╝" -ForegroundColor White
Write-Host ""

# ─── Check Docker ────────────────────────────────────────────────────

try {
    $null = docker info 2>$null
    if ($LASTEXITCODE -ne 0) { throw "not running" }
} catch {
    Die "Docker is not installed or not running. Install Docker Desktop from https://docker.com/products/docker-desktop"
}
Log "Docker $(docker --version)"

# ─── Detect existing installation ────────────────────────────────────

$CONTAINER_NAME = if ($env:CODECK_NAME) { $env:CODECK_NAME } else { $DEFAULT_NAME }
$IS_UPDATE = $false
$EXISTING_PORT = ""
$EXISTING_MEMORY = ""
$EXISTING_CPUS = ""

$existing = docker ps -a --format '{{.Names}}' 2>$null | Where-Object { $_ -eq $CONTAINER_NAME }
if ($existing) {
    $IS_UPDATE = $true
    $EXISTING_PORT = (docker inspect --format '{{index .Config.Labels "codeck.port"}}' $CONTAINER_NAME 2>$null)
    $EXISTING_MEMORY = (docker inspect --format '{{index .Config.Labels "codeck.memory"}}' $CONTAINER_NAME 2>$null)
    $EXISTING_CPUS = (docker inspect --format '{{index .Config.Labels "codeck.cpus"}}' $CONTAINER_NAME 2>$null)
    $EXISTING_IMAGE = (docker inspect --format '{{.Config.Image}}' $CONTAINER_NAME 2>$null)

    Write-Host ""
    Info "Existing Codeck found — this will update it."
    Info "Your data (workspace, config, keys) will be preserved."
    Write-Host ""

    if ($EXISTING_PORT) { $DEFAULT_PORT = $EXISTING_PORT }
    if ($EXISTING_IMAGE) { $DEFAULT_IMAGE = $EXISTING_IMAGE }
}

# ─── Configuration ───────────────────────────────────────────────────

$CODECK_IMAGE = if ($env:CODECK_IMAGE) { $env:CODECK_IMAGE } else { $DEFAULT_IMAGE }
$CODECK_PORT = $DEFAULT_PORT
$CODECK_MEMORY = if ($EXISTING_MEMORY) { $EXISTING_MEMORY } else { "" }
$CODECK_CPUS = if ($EXISTING_CPUS) { $EXISTING_CPUS } else { "" }

Ask "CODECK_PORT" "Port" $DEFAULT_PORT
Ask "CODECK_MEMORY" "Memory limit (e.g. 4g, or blank for unlimited)" $CODECK_MEMORY
Ask "CODECK_CPUS" "CPU limit (e.g. 2, or blank for unlimited)" $CODECK_CPUS

Write-Host ""

# ─── Pull image ──────────────────────────────────────────────────────

Info "Pulling $CODECK_IMAGE..."
docker pull $CODECK_IMAGE
if ($LASTEXITCODE -ne 0) { Die "Failed to pull image. Check your internet connection." }
Log "Image pulled"

# ─── Build docker run args ───────────────────────────────────────────

$DOCKER_ARGS = @(
    "--name", $CONTAINER_NAME,
    "--restart", "unless-stopped",
    "--init",
    "-p", "${CODECK_PORT}:80",
    "-v", "codeck-workspace:/workspace",
    "-v", "codeck-claude:/root/.claude",
    "-v", "codeck-ssh:/root/.ssh",
    "-v", "codeck-gh:/root/.config/gh",
    "--cap-drop", "ALL",
    "--cap-add", "CHOWN",
    "--cap-add", "SETUID",
    "--cap-add", "SETGID",
    "--cap-add", "NET_BIND_SERVICE",
    "--cap-add", "KILL",
    "--cap-add", "DAC_OVERRIDE",
    "--security-opt", "no-new-privileges:true",
    "--stop-timeout", "30",
    "--label", "codeck.port=$CODECK_PORT",
    "--label", "codeck.image=$CODECK_IMAGE",
    "--label", "codeck.installer=$VERSION"
)

if ($CODECK_MEMORY) {
    $DOCKER_ARGS += "--memory", $CODECK_MEMORY
    $DOCKER_ARGS += "--label", "codeck.memory=$CODECK_MEMORY"
}
if ($CODECK_CPUS) {
    $DOCKER_ARGS += "--cpus", $CODECK_CPUS
    $DOCKER_ARGS += "--label", "codeck.cpus=$CODECK_CPUS"
}

# ─── Stop existing + rollback safety ─────────────────────────────────

$existingContainer = docker ps -a --format '{{.Names}}' 2>$null | Where-Object { $_ -eq $CONTAINER_NAME }
if ($existingContainer) {
    docker stop $CONTAINER_NAME 2>$null | Out-Null
    docker rename $CONTAINER_NAME "${CONTAINER_NAME}-prev" 2>$null | Out-Null
    Info "Previous container saved as ${CONTAINER_NAME}-prev (rollback safety)"
}

# ─── Start new container ─────────────────────────────────────────────

Info "Starting Codeck..."
docker run -d @DOCKER_ARGS $CODECK_IMAGE --web
if ($LASTEXITCODE -ne 0) {
    Err "Failed to start new container"
    $prev = docker ps -a --format '{{.Names}}' 2>$null | Where-Object { $_ -eq "${CONTAINER_NAME}-prev" }
    if ($prev) {
        Warn "Rolling back to previous version..."
        docker rename "${CONTAINER_NAME}-prev" $CONTAINER_NAME 2>$null | Out-Null
        docker start $CONTAINER_NAME 2>$null | Out-Null
        Die "Rollback complete. Previous version is running."
    }
    Die "No previous version to rollback to."
}

# ─── Health check with auto-rollback ─────────────────────────────────

Info "Waiting for health check..."
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $result = docker exec $CONTAINER_NAME curl -sf http://localhost:80/api/auth/status 2>$null
        if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
    } catch {}
    Start-Sleep -Seconds 1
}

if (-not $healthy) {
    Warn "New version not healthy after 30s"
    $prev = docker ps -a --format '{{.Names}}' 2>$null | Where-Object { $_ -eq "${CONTAINER_NAME}-prev" }
    if ($prev) {
        Warn "Auto-rolling back..."
        docker stop $CONTAINER_NAME 2>$null | Out-Null
        docker rm $CONTAINER_NAME 2>$null | Out-Null
        docker rename "${CONTAINER_NAME}-prev" $CONTAINER_NAME 2>$null | Out-Null
        docker start $CONTAINER_NAME 2>$null | Out-Null
        Die "Rollback complete. Check: docker logs $CONTAINER_NAME"
    }
    Warn "No previous version. Check: docker logs $CONTAINER_NAME"
}

# Clean up old container after successful start
$prev = docker ps -a --format '{{.Names}}' 2>$null | Where-Object { $_ -eq "${CONTAINER_NAME}-prev" }
if ($prev) {
    docker rm "${CONTAINER_NAME}-prev" 2>$null | Out-Null
}

Log "Health check passed"

# ─── Done ─────────────────────────────────────────────────────────────

Write-Host ""
if ($IS_UPDATE) {
    Write-Host "  ═══════════════════════════════════════" -ForegroundColor Green
    Write-Host "    Codeck updated successfully!" -ForegroundColor Green
    Write-Host "  ═══════════════════════════════════════" -ForegroundColor Green
} else {
    Write-Host "  ═══════════════════════════════════════" -ForegroundColor Green
    Write-Host "    Codeck installed successfully!" -ForegroundColor Green
    Write-Host "  ═══════════════════════════════════════" -ForegroundColor Green
}

Write-Host ""
Write-Host "  Open: " -NoNewline
Write-Host "http://localhost:$CODECK_PORT" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Manage:" -ForegroundColor White
Write-Host "    docker logs codeck -f        — view logs"
Write-Host "    docker restart codeck        — restart"
Write-Host "    docker stop codeck           — stop"
Write-Host "    docker start codeck          — start"
Write-Host ""
Write-Host "  Update:" -ForegroundColor White
Write-Host "    irm https://codeck.xyz/install.ps1 | iex"
Write-Host ""

if ($CODECK_MEMORY -or $CODECK_CPUS) {
    Write-Host "  Resources:" -ForegroundColor White
    if ($CODECK_MEMORY) { Write-Host "    Memory: $CODECK_MEMORY" }
    if ($CODECK_CPUS) { Write-Host "    CPUs: $CODECK_CPUS" }
    Write-Host ""
}

Write-Host "  Data (persists across updates):" -ForegroundColor White
Write-Host "    Workspace:  codeck-workspace"
Write-Host "    Claude:     codeck-claude"
Write-Host "    SSH keys:   codeck-ssh"
Write-Host ""
Write-Host "  Installer v$VERSION" -ForegroundColor DarkGray
Write-Host ""
