# Progress Tracker

## Session 1 — Planning (2026-02-15)

### Completed
- Created `feature/improvements` branch from `main`
- Read and analyzed full architecture: `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, `README.md`
- Analyzed all relevant source files:
  - `docker-compose.yml` — main compose (has docker.sock mount, bridge mode)
  - `docker-compose.lan.yml` — LAN compose (has `network_mode: host`)
  - `docker-compose.dev.yml` — dev compose (just dockerfile override)
  - `src/services/port-manager.ts` — NetworkMode type includes 'host', conditionals for host mode
  - `src/services/auth-anthropic.ts` — has existing `performTokenRefresh()`, `scheduleProactiveRefresh()`, `readCredentials()`, `saveOAuthToken()`
  - `src/web/server.ts` — startup sequence, graceful shutdown, route mounting
  - `src/web/websocket.ts` — status broadcast, message protocol
  - `src/web/src/state/store.ts` — all frontend signals
  - `src/web/src/components/HomeSection.tsx` — dashboard component
- Created `docs/plans/implementation-plan.md` — full impact analysis + strategy
- Created `docs/plans/TODO.md` — 22 granular tasks across 4 features
- Created `docs/plans/PROGRESS.md` (this file)

### Key Findings
1. **Feature 1:** `docker-compose.lan.yml` uses `network_mode: host` with `ports: !reset []`. Port-manager has `NetworkMode = 'host' | 'bridge'` type.
2. **Feature 2:** `docker-compose.yml` already mounts `/var/run/docker.sock`. This is used by port-manager for dynamic port exposure via helper containers. Removing it breaks dynamic port mapping in default mode (acceptable trade-off for security).
3. **Feature 3:** No `environment.ts` exists yet — will create. Server.ts has no deployment mode detection.
4. **Feature 4:** `performTokenRefresh()` already exists with proper encryption handling. `REFRESH_MARGIN_MS = 5 * 60 * 1000` (5 min). Needs to be extended to 30 min for the monitor. The `refreshInProgress` flag prevents race conditions.

### Next Session
- Start with **T1.1** (docker-compose.lan.yml changes)
- Follow the execution order: Feature 1 → Feature 2 → Feature 4 → Feature 3

### Problems Encountered
- None so far

## Session 4 — Feature 3: Systemd Deployment (2026-02-15)

### Completed
- **T3.1**: Created `scripts/codeck.service` systemd unit file with [Unit], [Service], [Install] sections. Includes codeck user, resource limits (CPUQuota=200%, MemoryLimit=4G), NoNewPrivileges=true, and proper restart policy.

- **T3.2**: Created `scripts/install.sh` Part 1 — OS detection (Linux-only), root check, systemd check, distro-aware package manager detection (apt/dnf/yum), Node.js 22+ installation with version check, Docker installation via get.docker.com.

- **T3.3**: Completed `scripts/install.sh` Part 2 — Claude CLI installation (npm global), codeck user creation with docker group, workspace/config directory setup (/home/codeck/{workspace,.codeck,.claude,.ssh}), Codeck download from GitHub releases, npm production install, systemd service file copy + enable + start. Final output shows success message with useful commands.

- **T3.4**: Added `DeploymentMode` type (`'systemd' | 'docker' | 'cli-local'`), `detectDeploymentMode()` function (checks SYSTEMD_EXEC_PID → /.dockerenv → fallback), and `getDefaultConfig()` function (returns workspace/port defaults per mode) to `src/services/environment.ts`.

- **T3.5**: Wired `detectDeploymentMode()` into `src/web/server.ts`. Added import and log line `"Starting Codeck in [mode] mode"` in the listen callback.

- **T3.6**: Created `docs/DEPLOYMENT.md` with full systemd deployment guide (requirements, quick install, what installer does, service management, configuration overrides, resource limits, file paths, updating, troubleshooting). Updated `docs/README.md` index and `CLAUDE.md` docs table to include the new doc.

### Next
- **T3.7**: Update `README.md` with "Production Deployment" section

### Problems Encountered
- None
