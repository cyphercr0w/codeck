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

### Next
- **T3.2**: Create `scripts/install.sh` Part 1 (OS detection, root check, systemd check, dependency installation)

### Problems Encountered
- None
