# TODO — 4 Critical Features

Progress tracker with granular tasks. Each task is scoped to ~30-60 minutes max.

---

## Feature 1: Remove network_mode=host and Unify Port Mapping

### 1.1 Docker Compose Changes
- [x] **T1.1** Remove `network_mode: host`, `ports: !reset []`, and host-mode env vars from `docker-compose.lan.yml`. Replace with bridge-compatible LAN config (just mDNS enablement env var).
  - **Validation:** `docker-compose.lan.yml` has no `network_mode` directive. `grep -r "network_mode" docker-compose*.yml` returns nothing.

- [x] **T1.2** Remove `/var/run/docker.sock` mount from `docker-compose.yml` (this line moves to Feature 2's experimental file).
  - **Validation:** `grep "docker.sock" docker-compose.yml` returns nothing. All other volume mounts preserved.

### 1.2 Backend Changes
- [x] **T1.3** Remove `'host'` from `NetworkMode` type and all `host`-mode conditionals in `src/services/port-manager.ts`. Set `networkMode` to always be `'bridge'`.
  - **Validation:** `npm run build` succeeds. No references to `'host'` network mode in port-manager.ts.

### 1.3 Documentation Updates
- [x] **T1.4** Update `docs/ARCHITECTURE.md`: Remove "Host Mode" section from Network Isolation Model. Update Network Mode Architecture to bridge-only.
  - **Validation:** No references to `network_mode: host` in ARCHITECTURE.md.

- [x] **T1.5** Update `docs/CONFIGURATION.md`: Remove `CODECK_NETWORK_MODE=host` references. Update LAN access instructions.
  - **Validation:** No `host` mode documented as option for CODECK_NETWORK_MODE.

- [x] **T1.6** Update `README.md`: Simplify LAN access section (same on all OS — use mDNS advertiser script). Update architecture diagram if needed.
  - **Validation:** No mention of `network_mode: host` or Linux-specific LAN instructions.

- [x] **T1.7** Update `CLAUDE.md` (project): Update dev commands section if LAN command changed.
  - **Validation:** Commands in CLAUDE.md match actual compose file names/contents.

---

## Feature 2: Experimental Socket Mount with Warnings

### 2.1 Docker Compose
- [x] **T2.1** Create `docker-compose.experimental.yml` with Docker socket mount volume only.
  - **Validation:** File exists. Contains only the socket volume mount for the sandbox service.

### 2.2 Backend — Detection
- [x] **T2.2** Create `src/services/environment.ts` with `detectDockerSocketMount()` function. Export it.
  - **Validation:** `npm run build` succeeds. Function returns `true` when `/var/run/docker.sock` exists, `false` otherwise.

- [x] **T2.3** Include `dockerExperimental` in `/api/status` response (server.ts) and WebSocket initial status (websocket.ts).
  - **Validation:** `npm run build` succeeds. Status response includes `dockerExperimental` boolean field.

### 2.3 Frontend — Warning Banner
- [x] **T2.4** Add `dockerExperimental` signal to `src/web/src/state/store.ts`. Update `updateStateFromServer()` to read it from status data.
  - **Validation:** `npm run build` succeeds.

- [x] **T2.5** Add persistent warning banner in `HomeSection.tsx` when `dockerExperimental` is true. Warning text: "Experimental Mode Active — Docker socket is mounted. The container has full access to the host Docker daemon. This removes container isolation. Only use on trusted systems."
  - **Validation:** `npm run build` succeeds. Component renders warning when signal is true.

### 2.4 Documentation
- [x] **T2.6** Update `README.md` with "Docker Socket Access" section explaining default (secure) vs experimental mode.
  - **Validation:** README explains how to activate experimental mode and its security implications.

- [x] **T2.7** Update `docs/CONFIGURATION.md` with experimental mode documentation.
  - **Validation:** Configuration doc covers `docker-compose.experimental.yml` usage.

---

## Feature 3: Systemd Deployment Preparation

### 3.1 Scripts
- [x] **T3.1** Create `scripts/codeck.service` systemd unit file with the specified configuration.
  - **Validation:** File exists with correct [Unit], [Service], [Install] sections.

- [ ] **T3.2** Create `scripts/install.sh` — Part 1: OS detection, root check, systemd check, dependency installation (Node.js 22+, Docker).
  - **Validation:** Script is executable. `bash -n scripts/install.sh` passes syntax check.

- [ ] **T3.3** Create `scripts/install.sh` — Part 2: Claude CLI install, user creation, directory setup, service installation, enable + start.
  - **Validation:** Script is complete. `bash -n scripts/install.sh` passes. All steps from the spec are present.

### 3.2 Backend — Environment Detection
- [ ] **T3.4** Add `detectDeploymentMode()` and `getDefaultConfig()` to `src/services/environment.ts`.
  - **Validation:** `npm run build` succeeds. Functions return correct values for docker (/.dockerenv exists), cli-local (default), and systemd (SYSTEMD_EXEC_PID exists).

- [ ] **T3.5** Import and use `detectDeploymentMode()` in `src/web/server.ts` — log deployment mode at startup.
  - **Validation:** `npm run build` succeeds. Server startup shows "Starting Codeck in [mode] mode" log line.

### 3.3 Documentation
- [ ] **T3.6** Create `docs/DEPLOYMENT.md` with systemd installation guide, requirements, commands, troubleshooting.
  - **Validation:** Document exists with complete guide.

- [ ] **T3.7** Update `README.md` with "Production Deployment" section pointing to DEPLOYMENT.md.
  - **Validation:** README includes production deployment section.

---

## Feature 4: OAuth Token Auto-Refresh Monitor

### 4.1 Backend — Refresh Monitor
- [x] **T4.1** Add constants (`TOKEN_CHECK_INTERVAL`, `REFRESH_MARGIN`, `MAX_REFRESH_RETRIES`) and `startTokenRefreshMonitor()` function to `src/services/auth-anthropic.ts`.
  - **Validation:** `npm run build` succeeds. Function creates an interval that checks token expiry.

- [x] **T4.2** Add `refreshAccessToken()` enhanced version with retry tracking and broadcast events (`token_refreshed`, `token_error`). Add `stopTokenRefreshMonitor()`.
  - **Validation:** `npm run build` succeeds. Monitor can be started and stopped cleanly.

- [x] **T4.3** Wire up in `src/web/server.ts`: call `startTokenRefreshMonitor()` in post-listen, call `stopTokenRefreshMonitor()` in `gracefulShutdown()`.
  - **Validation:** `npm run build` succeeds. Server startup log shows "Token refresh monitor started". Shutdown stops the monitor.

### 4.2 Documentation
- [ ] **T4.4** Update `docs/ARCHITECTURE.md` — Add token auto-refresh monitor to the process lifecycle (startup/shutdown) and token lifecycle sections.
  - **Validation:** ARCHITECTURE.md documents the monitor interval and refresh flow.

---

## Final
- [ ] **T-FINAL** Verify all features: `npm run build` passes. All 4 features documented. Commit "feat: all 4 features completed".
