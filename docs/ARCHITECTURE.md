# Technical Architecture — Codeck Sandbox

## Table of Contents

1. [Overview](#overview)
2. [Process lifecycle](#process-lifecycle)
3. [Backend](#backend)
4. [Frontend](#frontend)
5. [Authentication flows](#authentication-flows)
6. [WebSocket protocol](#websocket-protocol)
7. [PTY terminal management](#pty-terminal-management)
8. [Agent Teams](#agent-teams)
9. [Port exposure](#port-exposure)
10. [Memory system](#memory-system)
11. [Preset system](#preset-system)
12. [Docker infrastructure](#docker-infrastructure)
13. [Container filesystem at runtime](#container-filesystem-at-runtime)
14. [Security model](#security-model)
15. [Caching and in-memory state](#caching-and-in-memory-state)
16. [Concurrency & state management](#concurrency--state-management)
17. [Module dependencies](#module-dependencies)

---

## Overview

Codeck runs as a **single Docker container**. One Express server on port 80 handles everything: the Preact SPA, REST API, WebSocket connections, PTY terminals, memory system, proactive agents, and auth.

### Architecture

```
┌─────────────────┐
│   Browser        │
│  (Preact SPA)    │
└────────┬─────────┘
         │
   HTTP + WebSocket
         │
┌────────┴──────────────────────────┐
│     Express Server (:80)           │
│                                    │
│  ├─ Static Files (apps/web/dist)  │
│  ├─ Auth Middleware               │
│  ├─ REST Routes (/api/*)          │
│  ├─ WebSocket Server              │
│  ├─ Services (PTY, files, memory) │
│  └─ /internal/status (health)     │
└───────────────────────────────────┘
```

The server serves the SPA, handles auth, and runs all backend logic. No Docker socket required. Works on Linux, macOS, and Windows.

### Project structure

```
apps/
├── web/        Preact SPA (Vite build → apps/web/dist/)
└── runtime/    Backend: PTY, files, memory, agents, auth (Express + WS)
```

Both apps build independently (`npm run build`). The system does not use a database for core state — all state lives in memory (Map/variables) and in JSON files on disk. SQLite is used only for the FTS5 memory search index.

---

## Process lifecycle

### Startup

```
Docker ENTRYPOINT
    │
    ▼
init-keyring.sh
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
                    └── server.listen(PORT)
                        └── [post-listen callbacks]
                            ├── initPortManager()           → Read env vars, detect network mode
                            ├── updateClaudeMd()            → Creates/updates /workspace/CLAUDE.md from template + project list
                            ├── ensureDirectories()         → Creates memory system directories
                            ├── ensureMcpServers()          → Registers MCP servers in .claude.json
                            ├── updateAgentBinary()         → Auto-updates Claude CLI (background, non-blocking)
                            ├── initializeEmbeddings()      → Text embedding provider (WASM or Gemini fallback)
                            ├── initializeIndexer()         → SQLite FTS5 indexer initialization
                            ├── initializeSearch()          → Memory search system initialization
                            ├── startPortScanner()          → Detects listening ports every 5s
                            ├── startMdns()                 → mDNS responder for codeck.local (LAN mode)
                            ├── startTokenRefreshMonitor()  → Background OAuth token refresh (every 5min, 30min margin)
                            ├── initTeamTemplates()         → Creates built-in Agent Teams templates (Security Audit, Code Review)
                            ├── initProactiveAgents()       → Cron scheduler + agent runtime startup
                            ├── initConsolidationCron()     → Weekly memory consolidation (Sunday 02:00 UTC)
                            └── restoreSavedSessions()      → Auto-resume sessions from previous lifecycle (delayed 2s)
```

### Shutdown

```
SIGTERM / SIGINT
    │
    ▼
gracefulShutdown()
    ├── saveSessionState()       → Persists sessions for auto-restore
    ├── stopTokenRefreshMonitor()→ Clears token check interval
    ├── shutdownProactiveAgents()→ Stops cron schedules, kills running executions
    ├── shutdownConsolidationCron() → Stops weekly cron
    ├── shutdownEmbeddings()     → Clean up embedding resources
    ├── shutdownSearch()         → Closes SQLite read connection
    ├── shutdownIndexer()        → Closes SQLite write connection
    ├── stopMdns()               → Stops mDNS responder
    ├── stopPortScanner()        → Clears port scanning interval timer
    ├── destroyAllSessions()     → Kills all PTYs
    ├── server.close()           → Closes HTTP/WS connections
    └── setTimeout(5000)         → Force exit if it doesn't close
```

The container uses `tini` as PID 1 (`init: true` in docker-compose) to reap zombie processes from dev servers.

---

## Backend

### Middleware pipeline

Requests pass through this pipeline in order:

```
Request → /internal/status (pre-auth) → Static Files → JSON Parser
        → Rate Limiter → Auth Endpoints (public) → Auth Middleware → Routes
```

1. **Internal endpoint** — `/internal/status` returns `{status: "ok", uptime}`. Registered before all other middleware; used for health checks.
2. **Static files** — `express.static(apps/web/dist)` serves the compiled frontend.
3. **JSON parser** — `express.json()` for body parsing.
4. **Rate limiter** — In-memory Map, per-route: 10 req/min for `/api/auth`, 200 req/min for `/api/*`, with 5-minute stale IP cleanup.
5. **Auth endpoints** — `/api/auth/status`, `/setup`, `/login` are public; `/logout` and `/change-password` are protected.
6. **Auth middleware** — Validates `Authorization: Bearer <token>` or `?token=` query param against `activeSessions` Map. Localhost bypass for `/api/memory/*` (agent access from inside the container).
7. **Routes** — 19 routers mounted at `/api/<domain>`, plus inline auth/status/logs/ports/account endpoints.

### Service layer

Each service is an ES module with pure functions (no classes). Mutable state is encapsulated in module variables.

| Service | File | In-memory state | Disk persistence |
|---------|------|-----------------|------------------|
| `auth` | `services/auth.ts` | `activeSessions: Map<token, {createdAt}>` | `/workspace/.codeck/auth.json` (hash+salt+algo, mode 0600) |
| `auth-anthropic` | `services/auth-anthropic.ts` | `loginState`, `authCache`, `currentCodeVerifier/State` | `/root/.claude/.credentials.json` (OAuth token, AES-256-GCM encrypted, mode 0600) |
| `agent-usage` | `services/agent-usage.ts` | `cachedUsage` (60s TTL) | None (fetches from Anthropic API) |
| `git` | `services/git.ts` | `gitHubConfig`, `sshTestCache`, CLI check caches | `/root/.ssh/*`, `/workspace/CLAUDE.md` (from template) |
| `console` | `services/console.ts` | `sessions: Map<id, ConsoleSession>` | `/root/.claude.json` (onboarding flag) |
| `cli-auth` | `services/cli-auth.ts` | `activeLogins: Map<service, state+proc>` | None (delegates to CLI tools like `vercel`) |
| `mdns` | `services/mdns.ts` | `responder` (multicast-dns instance) | None (network socket only) |
| `preset` | `services/preset.ts` | None | `/workspace/.codeck/config.json` (active preset) |
| `resources` | `services/resources.ts` | `prevCpuUsage` (for delta calculation) | None (reads cgroups v2 / OS APIs) |
| `memory` | `services/memory.ts` | `flushState` (rate-limit tracking) | `/workspace/.codeck/memory/*`, `/workspace/.codeck/state/` |
| `memory-indexer` | `services/memory-indexer.ts` | `db` (better-sqlite3 instance), file watcher | `/workspace/.codeck/index/memory.sqlite` |
| `memory-search` | `services/memory-search.ts` | `db` (better-sqlite3 readonly) | `/workspace/.codeck/index/memory.sqlite` |
| `memory-consolidation` | `services/memory-consolidation.ts` | `cronJob`, `isRunning` mutex | `/workspace/.codeck/memory/archive/`, `/workspace/.codeck/state/consolidation-state.json` |
| `memory-context` | `services/memory-context.ts` | None | Injects into `/workspace/CLAUDE.md` |
| `session-writer` | `services/session-writer.ts` | `sessionStreams: Map`, input/output buffers | `/workspace/.codeck/sessions/*.jsonl` |
| `session-summarizer` | `services/session-summarizer.ts` | None | Writes to daily memory log |
| `permissions` | `services/permissions.ts` | None | `/workspace/.codeck/config.json`, `/root/.claude/settings.json` |
| `port-manager` | `services/port-manager.ts` | `networkMode`, `mappedPorts: Set`, `containerId`, compose labels | Writes `compose.override.yml` via Docker helper |
| `ports` | `services/ports.ts` | Cached port list | None |
| `proactive-agents` | `services/proactive-agents.ts` | `agents: Map`, `cwdLocks`, `cwdQueues` | `/workspace/.codeck/agents/` |
| `teams` | `services/teams.ts` | None | `/workspace/.codeck/teams/templates/*.json`, `/workspace/.codeck/teams/executions/*.json` |
| `tmux-bridge` | `services/tmux-bridge.ts` | `activeExecutions: Map` | Bridges tmux panes to console sessions |
| `tmux-pty-adapter` | `services/tmux-pty-adapter.ts` | Per-instance state (callbacks, tail process) | `/tmp/codeck-tmux-pipes/` (ephemeral) |
| `conversation-storage` | `services/conversation-storage.ts` | None | `/workspace/.codeck/chat/conversations/*.json` |
| `chat-api-handler` | `services/chat-api-handler.ts` | Active streams | None (stateless, streams to response) |
| `embeddings` | `services/embeddings.ts` | Provider instance | None |
| `environment` | `services/environment.ts` | Environment constants | None |
| `claude-env` | `services/claude-env.ts` | Cached binary path | None |
| `logger` | `web/logger.ts` | `logBuffer: LogEntry[]` (circular, max 100), `wsClients[]` | None |

### Routers

Each router is an `express.Router()` mounted at a path prefix in `server.ts`:

| Router | Mount path | Delegates to |
|--------|-----------|-------------|
| `agent.routes.ts` | `/api/claude` | `services/auth-anthropic.ts` — OAuth login flow |
| `chat.routes.ts` | `/api/chat` | `services/conversation-storage.ts` + `services/chat-api-handler.ts` — Chat conversations + streaming responses |
| `cli-auth.routes.ts` | `/api/cli-auth` | `services/cli-auth.ts` — Third-party CLI auth (Vercel, etc.) |
| `codeck.routes.ts` | `/api/codeck` | Direct fs — `/workspace/.codeck/` agent data CRUD + env vars |
| `console.routes.ts` | `/api/console` | `services/console.ts` — PTY session management |
| `dashboard.routes.ts` | `/api/dashboard` | `services/resources.ts` + `services/agent-usage.ts` |
| `files.routes.ts` | `/api/files` | Direct fs — `/workspace/` file browsing |
| `git.routes.ts` | `/api/git` | `services/git.ts` — Repository cloning |
| `github.routes.ts` | `/api/github` | `services/git.ts` — GitHub device code login |
| `hooks.routes.ts` | `/api/hooks` | Hook management API |
| `mcp.routes.ts` | `/api/mcp` | MCP server management |
| `memory.routes.ts` | `/api/memory` | `services/memory.ts`, `services/memory-search.ts`, `services/session-writer.ts` |
| `permissions.routes.ts` | `/api/permissions` | `services/permissions.ts` — Tool + MCP permissions |
| `preset.routes.ts` | `/api/presets` | `services/preset.ts` — List/apply/reset presets |
| `project.routes.ts` | `/api/projects` | Direct spawn + `services/git.ts` — Create/clone projects |
| `skills.routes.ts` | `/api/skills` | Skill listing and loading |
| `ssh.routes.ts` | `/api/ssh` | `services/git.ts` — SSH key management |
| `system.routes.ts` | `/api/system` | `services/port-manager.ts` — Network info, port exposure, model switching |
| `workspace.routes.ts` | `/api/workspace` | Direct spawn — Export workspace as tar.gz |
| `agents.routes.ts` | `/api/agents` | `services/proactive-agents.ts` — Proactive agent CRUD + scheduler |
| `teams.routes.ts` | `/api/teams` | `services/teams.ts` + `services/tmux-bridge.ts` — Agent Teams template CRUD + launch/stop |

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

**Logging Destinations**:
1. Container stdout/stderr → Docker json-file driver (with rotation: 10MB max-size, 3 max-file)
2. In-memory circular buffer → WebSocket clients for real-time UI
3. Session transcripts → `/workspace/.codeck/sessions/*.jsonl` (PTY input/output)
4. Agent execution logs → `/workspace/.codeck/agents/*/executions/*.{jsonl,log}` (proactive agents)

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
    │   ├── Navigation (home/chat/claude/teams/agents/integrations/config)
    │   ├── Connection status dot
    │   └── Brand header
    ├── Content Area
    │   ├── [section=home]          → HomeSection (dashboard)
    │   ├── [section=chat]          → ChatSection (conversational UI)
    │   ├── [section=filesystem]    → FilesSection
    │   ├── [section=claude]        → ClaudeSection (terminal tabs)
    │   ├── [section=teams]         → TeamsSection (Agent Teams launcher + execution viewer)
    │   ├── [section=agents]        → AgentsSection (proactive agents)
    │   ├── [section=integrations]  → IntegrationsSection
    │   ├── [section=config]        → AgentConfigSection (.codeck file editor)
    │   └── [section=settings]      → SettingsSection (password, sessions, permissions, logs, ports)
    ├── ToastContainer
    ├── SubagentPanel
    ├── LoginModal
    ├── NewProjectModal
    └── ReconnectOverlay
```

### State (Signals)

Declared in `state/store.ts` as global singletons:

| Signal | Type | Default | Description |
|--------|------|---------|-------------|
| `view` | `View` | `'loading'` | Current view |
| `activeSection` | `Section` | `'home'` | Active main section |
| `authMode` | `AuthMode` | `'login'` | Auth view mode |
| `claudeAuthenticated` | `boolean` | `false` | Claude account connected |
| `accountEmail` | `string \| null` | `null` | User email |
| `accountOrg` | `string \| null` | `null` | Organization name |
| `accountUuid` | `string \| null` | `null` | Account UUID |
| `sessions` | `TerminalSession[]` | `[]` | Active PTY sessions |
| `activeSessionId` | `string \| null` | `null` | Currently focused session |
| `sessionStatus` | `Record<string, SessionStatus>` | `{}` | Per-session status (active/idle/waiting/exited) |
| `wsConnected` | `boolean` | `false` | WebSocket connected |
| `restoringPending` | `boolean` | `false` | Session restore in progress |
| `logs` | `LogEntry[]` | `[]` | Log entries |
| `logsExpanded` | `boolean` | `false` | Logs drawer open |
| `presetConfigured` | `boolean` | `false` | Preset applied |
| `workspacePath` | `string` | `'/workspace'` | Workspace path |
| `agentName` | `string` | `'Claude'` | Agent name |
| `activePorts` | `PortInfo[]` | `[]` | Listening ports with exposure status |
| `dockerExperimental` | `boolean` | `false` | Docker experimental mode |
| `currentFilesPath` | `string` | `''` | Files section current path |
| `isMobile` | `boolean` | `detectMobile()` | Feature-based mobile detection |
| `mobileKeyboardOpen` | `boolean` | `false` | Mobile keyboard open state |
| `activeSubagents` | `SubagentInfo[]` | `[]` | Active sub-agents from hooks |
| `toasts` | `Toast[]` | `[]` | Toast notification queue |

Derived signals: `activeSession`, `sessionCount`.

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
    │           └── Network error → retry with exponential backoff (1s → 30s cap)
```

---

## Authentication flows

### 1. Local password

Single-user password auth stored in the container.

```
┌────────┐                         ┌────────┐                    ┌─────────────────────────┐
│ Browser│                         │ Server │                    │ /workspace/.codeck/     │
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

Sessions expire after 7 days (`SESSION_TTL_MS`). No refresh — user re-logs in. Legacy SHA-256 hashes are auto-migrated to scrypt on successful login.

**Session Management Architecture:**

Codeck uses **Bearer token authentication** with localStorage client-side storage. This design supports:

1. **WebSocket Authentication** — Native WebSocket API requires token in URL or subprotocol
2. **File Download Authentication** — Content-Disposition downloads can't send Authorization headers
3. **LAN Access Simplicity** — Avoids SameSite/CORS cookie complexity for `.codeck.local` domains

**Session Token Properties:**
- 256-bit cryptographically random (exceeds OWASP 128-bit minimum)
- Regenerated on every login (session fixation prevention)
- Stored server-side in memory Map + persisted atomically to `sessions.json` (mode 0o600)
- 7-day fixed TTL by default (configurable via `SESSION_TTL_MS` env var)
- All sessions invalidated on password change

**Authentication Mechanisms:**
- API requests: `Authorization: Bearer <token>` header
- WebSocket: `?token=<token>` query parameter
- Downloads: `?token=<token>` query parameter

**Rate Limiting Tiers:**
- `/api/auth/*`: 10 requests/minute (brute-force protection)
- `/api/*` (general): 200 requests/minute
- Login endpoint: 5-attempt lockout (15-minute IP ban)

### CORS Configuration

Codeck does **NOT** implement CORS middleware. The server runs on `localhost` or LAN (via `codeck.local`), not exposed to public internet. Browser same-origin policy prevents external sites from calling Codeck's API. WebSocket connections use explicit Origin header validation.

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
    │                   │ code_verifier = randomBytes(32) → base64url       │
    │                   │ state = randomBytes(32) → base64url               │
    │                   │ nonce = randomBytes(32) → base64url               │
    │                   │ code_challenge = SHA-256(code_verifier) → base64url│
    │                   │ Persist to .pkce-state.json (0o600)               │
    │                   │                      │                            │
    │ {url, started}    │                      │                            │
    │<──────────────────│                      │                            │
    │                   │                      │                            │
    │ User opens URL in another tab → authorizes → copies code              │
    │                   │                      │                            │
    │ POST /api/claude/ │                      │                            │
    │   login-code      │                      │                            │
    │  {code}           │                      │                            │
    │──────────────────>│                      │                            │
    │                   │ POST platform.claude.com/v1/oauth/token           │
    │                   │  {grant_type, code, redirect_uri, client_id,      │
    │                   │   code_verifier, state}                           │
    │                   │─────────────────────────────────────────────────>│
    │                   │                      │  {access_token, refresh_   │
    │                   │                      │   token, account, org}     │
    │                   │<─────────────────────────────────────────────────│
    │                   │                      │                            │
    │                   │ Save to .credentials.json (AES-256-GCM encrypted) │
    │                   │ File permissions: 0o600                            │
    │                   │ Delete .pkce-state.json                            │
    │                   │                      │                            │
    │ {success: true}   │                      │                            │
    │<──────────────────│                      │                            │
```

**Code parsing:** Accepts raw code, code#state, full URL, or direct `sk-ant-oat01-...` token.

**Token Lifecycle:**
- **Auto-Refresh Monitor:** Runs every 5 minutes, refreshes tokens 30 minutes before expiry.
- **Concurrency Control:** `refreshInProgress` flag prevents race conditions.
- **Revocation Detection:** 401 from Claude API triggers refresh attempt before clearing credentials.
- **PKCE State Cleanup:** 5-minute TTL, cleaned on timeout/success/error/startup.

### 3. GitHub Device Code Flow

```
POST /api/github/login
    → spawn('gh', ['auth', 'login', '--web', '-h', 'github.com'])
    → Captures device code and URL from stdout via regex
    → User opens github.com/login/device, enters code
    → gh completes flow automatically
```

### 4. Third-Party CLI Auth

Generic device flow for external services (currently Vercel):

```
POST /api/cli-auth/:service/login
    → spawn(config.command, config.args)
    → Captures URL and code from stdout
    → Polls /api/cli-auth/:service/status for completion
    → Service-specific success pattern detection
```

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

### Server → Client Messages

| type | data | Trigger |
|------|------|---------|
| `status` | `{claude, git, preset, sessions?, account?, workspace?, agent?}` | Connection, post-login, post-clone, post-auth change |
| `log` | `LogEntry` | Each console.log/error from the server |
| `logs` | `LogEntry[]` | On connect (full buffer) |
| `console:output` | `{sessionId, data}` | Each output from the PTY |
| `console:exit` | `{sessionId, exitCode}` | PTY terminates |
| `console:error` | `{sessionId, error}` | Session not found on attach |
| `ports` | `PortInfo[]` | Port scanner detects change |
| `sessions:restored` | `{id, type, cwd, name}[]` | Sessions auto-restored after container restart |
| `heartbeat` | `{ts}` | Every 25s |
| `agent:update` | `ProactiveAgent` | Agent created, updated, or status changed |
| `agent:output` | `{agentId, text}` | Streaming output from running agent |
| `agent:execution:start` | `{agentId, executionId}` | Agent execution started |
| `agent:execution:complete` | `{agentId, executionId, result}` | Agent execution finished |
| `subagent:start` | `SubagentInfo` | Sub-agent spawned by Claude Code |
| `subagent:stop` | `{agentId, duration}` | Sub-agent completed |
| `team:launched` | `{executionId, templateName, agents[], leaderSessionId}` | Agent Team launched via tmux |
| `team:agent:detected` | `{executionId, agentId, name, role, sessionId, tmuxPane}` | Teammate pane detected by pane watcher |
| `team:stopped` | `{executionId, status}` | Agent Team execution completed/cancelled/failed |
| `team:agent:shutdown` | `{executionId, agentId}` | Individual teammate agent process exited |

### Client → Server Messages

| type | params | Effect |
|------|--------|--------|
| `console:attach` | `{sessionId}` | Registers onData/onExit listener for the PTY |
| `console:input` | `{sessionId, data}` | Writes to the PTY stdin |
| `console:resize` | `{sessionId, cols, rows}` | Resizes the PTY |

### Heartbeat & Stale Detection

**Server-side:** Sends WebSocket ping frames every 30s, terminates dead clients.

**Application-level:** Broadcasts `{type: 'heartbeat'}` every 25s. Client checks every 10s: if no data received in 45s, force-reconnects.

**Reconnection:** Exponential backoff: 1s → 2s → 4s → ... → 30s cap, with 50-100% jitter. Max 15 attempts. On reconnect, server sends `status` with current session list for sync.

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
    ├── Disposes previous PTY handlers
    ├── session.pty.onData → ws.send({type:'console:output'})
    ├── session.pty.onExit → ws.send({type:'console:exit'}) + destroySession()
    └── Replays buffered output

3. WS: {type:'console:input', sessionId, data}  → session.pty.write(data)
4. WS: {type:'console:resize', sessionId, cols, rows}  → session.pty.resize(cols, rows)
5. POST /api/console/destroy {sessionId}  → session.pty.kill() + cleanup
```

### Technical details

- **node-pty** compiles native C++ bindings. The base image pre-compiles in `/prebuilt/`.
- Claude CLI executed with OAuth token via `CLAUDE_CODE_OAUTH_TOKEN` env var.
- `ensureOnboardingComplete()` writes `hasCompletedOnboarding: true`, `hasTrustDialogAccepted: true`, `theme: "dark"` to skip CLI welcome screens.
- Permissions (Read, Edit, Write, Bash, WebFetch, WebSearch) synced to `settings.json`.
- Max 5 simultaneous sessions enforced in route handler.
- Sessions support `--resume` for continuing previous conversations.
- Shell sessions (`createShellSession`) do NOT require Claude authentication.

### Data Flow and Backpressure

1. **PTY Layer:** node-pty spawns child processes with xterm-256color emulation
2. **WebSocket Layer:** 64KB maxPayload, 300 msg/min rate limiting
3. **Rendering Layer:** xterm.js renders ANSI sequences in browser

**Output Buffering:** Unattached sessions buffer up to 1MB (FIFO eviction). On attach, buffered output is replayed.

**Backpressure:** PTY is paused before each `ws.send()` and always resumed in the callback, preventing unbounded buffer growth while avoiding permanent freeze on transient errors.

### Session persistence

Sessions are saved to disk and auto-restored on container restart via `saveSessionState()` / `restoreSavedSessions()` in `console.ts`. Agent sessions restore with `--resume` and optional continuation prompts.

---

## Agent Teams

Agent Teams enable parallel multi-agent collaboration via Claude Code's built-in `Agent`/`SendMessage`/`TaskCreate` tools. When `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set and the "Agent Teams" checkbox is enabled at launch, a system prompt is injected (via `--append-system-prompt`) instructing Claude to act as a team leader — spawning teammates, creating tasks, and coordinating work.

> **Since Claude Code 2.1.178**, Agent Teams is *implicit*: the `TeamCreate`/`TeamDelete` tools were removed and every session is already a team. Teammates are spawned directly via the `Agent` tool's `name` parameter (the old `team_name` param is accepted but ignored). No explicit team-creation step is needed.

### Activation flow

```
1. Agent Teams is opt-in-advanced (the launch checkbox was removed — the default is subagents-only, per the read-parallel/write-serial posture). When enabled programmatically (`enableTeams: true`):
2. Frontend sends enableTeams: true → POST /api/console/create
3. console.routes.ts sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in session env
4. console.ts detects the env var and appends team leader system prompt
5. Claude spawns teammates via Agent(name, subagent_type, model: sonnet) + TaskCreate for the shared task list
6. TeammateWatcher polls for tmux panes and broadcasts events to frontend
```

### Pane watcher

`startPaneWatcher()` polls `tmux list-panes` every 2s:

- New panes bridged via `bridgeNewPane()` → creates `TmuxPtyAdapter` → `registerVirtualSession()`
- Agent matched to template by pane index order (pane 1 = first agent, pane 2 = second, etc.)
- Broadcasts `team:agent:detected` WS event for each new teammate

### Completion detection

Three conditions trigger team completion:

1. **tmux session died** — entire session gone
2. **Teammates done** — all teammate Claude processes exited AND >90s since first teammate detected (prevents false positives during startup)
3. **Timeout** — no Claude processes at all for 5 minutes (team failed to spawn)

Individual agent shutdown detected when pane's current command changes from `claude` to another process → broadcasts `team:agent:shutdown`.

### TmuxPtyAdapter

IPty-compatible wrapper that bridges tmux panes to the console session infrastructure:

- **Output**: `tmux pipe-pane -O` → temp file → `tail -f` → `onData()` callbacks
- **Input**: `tmux send-keys` with special key mapping (Enter, Ctrl+C, arrows, etc.)
- **Resize**: `tmux resize-pane`
- **Liveness**: Polls every 5s, auto-destroys on pane death
- **Initial screen**: Captures pane content at bridge time for immediate display

---

## Port exposure

Dev server ports are exposed directly via Docker port mappings. No proxy involved.

```
Browser: GET http://localhost:3000/
    │
    └── Docker port mapping (3000:3000)
        └── Container service on 0.0.0.0:3000
```

**Default:** Only port 80 is mapped. Additional ports added via:
- **Dashboard UI**: Port Mapping card
- **API**: `POST /api/system/add-port`
- **Manual**: Edit `compose.override.yml`

**Auto-restart flow (bridge mode with compose info):**
1. Generates `compose.override.yml` with new port mapping
2. Writes to host via helper container (base64 pipe)
3. Saves session state for auto-restore
4. Spawns detached helper container running `docker compose up -d` after 3s delay
5. Container recreated with new ports, sessions auto-restore

**Port Scanner:** Runs `ss -tlnp` every 5s, broadcasts changes via WebSocket.

---

## Memory system

File-based persistence with SQLite FTS5 search. All data in `/workspace/.codeck/`.

### Directory layout

```
/workspace/.codeck/
  memory/
    MEMORY.md                    # Global durable memory
    daily/
      YYYY-MM-DD.md              # Global daily append-only logs
    decisions/
      ADR-YYYYMMDD-<slug>.md     # Global ADR files
    paths/
      <pathId>/                  # Path-scoped memory
        MEMORY.md
        daily/
          YYYY-MM-DD.md
        decisions/
          ADR-YYYYMMDD-<slug>.md
    archive/                     # Consolidation archive
      warm/                      # Recently consolidated
      cold/                      # Decayed entries
  sessions/
    <session-id>.jsonl           # Session transcripts
  index/
    memory.sqlite                # SQLite FTS5 index
  state/
    paths.json                   # Path registry
    flush-state.json             # Flush rate-limit state
    sessions.json                # Saved session state for restore
    consolidation-state.json     # Consolidation pipeline state
```

### Path-scoped memory

Paths are hashed using SHA-256 (first 12 characters) to create a `pathId`. The `paths.json` registry maps pathIds to canonical paths. All memory operations accept optional `pathId` for scoping.

### Search (FTS5 + Hybrid)

- **BM25 search:** Full-text search across all memory files
- **Vector search:** sqlite-vec with 384d embeddings (optional, requires embedding provider)
- **Hybrid search:** Combined BM25 + vector with Reciprocal Rank Fusion (0.4 BM25 / 0.6 vector)
- **Providers:** Local WASM (`@xenova/transformers`) or Gemini fallback (`GEMINI_API_KEY`)

### Context injection

When a new terminal session starts, `memory-context.ts` assembles relevant context from daily entries, path memory, and FTS results, then injects it into `/workspace/CLAUDE.md` between `<!-- MEMORY_CONTEXT_START -->` / `<!-- MEMORY_CONTEXT_END -->` markers.

### Memory consolidation

Weekly cron (Sunday 02:00 UTC) runs the consolidation pipeline:
1. Haiku extraction from daily logs to `pending-consolidation.md`
2. Apply suggestions to durable memory
3. Ebbinghaus decay on WARM tier entries
4. Generate weekly stats digest

---

## Preset system

### Available presets

| Preset | Description | Files installed |
|--------|-------------|----------------|
| `default` | Persistent memory system, rules, skills, agents, hooks, MCP servers | Full agent configuration |
| `empty` | Clean slate, minimal configuration | CLAUDE.md only |

### Manifest format

```json
{
  "id": "my-preset",
  "name": "My Custom Preset",
  "description": "Description shown in wizard",
  "version": "1.0.0",
  "author": "name",
  "icon": "...",
  "tags": ["custom"],
  "extends": "default",
  "files": [
    { "src": "skills/my-skill.md", "dest": "/workspace/.codeck/skills/my-skill.md" }
  ],
  "directories": []
}
```

### Inheritance

`"extends": "default"` inherits all files from parent. Child overwrites matching destinations. Max chain depth: 5, circular reference detection.

### Data file protection

Files in `memory/` paths, named `preferences.md`, or in `rules/` paths are "data files". Only copied on first apply; subsequent applies skip to preserve customizations. Use `POST /api/presets/reset` (force) to overwrite.

### On-demand language rules

Only `common/` and `typescript/` rules are permanently installed in `~/.claude/rules/`. All other language rulesets live in `/workspace/.codeck/rules-library/` and are symlinked into `~/.claude/rules/` at session start by `setupLanguageRules(cwd)` based on project indicator files. See [CONFIGURATION.md — On-demand language rules loading](CONFIGURATION.md) for details.

### CLAUDE.md Instruction File Hierarchy

Three-layer system providing hierarchical context:

1. **Layer 1 (Global):** `/root/.claude/CLAUDE.md` — Agent operational instructions, memory rules, session sequences. Deployed by preset system.
2. **Layer 2 (Workspace):** `/workspace/CLAUDE.md` — Workspace rules, scope boundaries, project listing. Updated by git service (`updateClaudeMd()` updates project list via marker).
3. **Layer 3 (Project):** `/workspace/<project>/CLAUDE.md` — Project-specific instructions. User-managed.

Layers loaded sequentially (1 → 2 → 3) by Claude Code CLI.

---

## Docker infrastructure

### Image layers

```
codeck-base (~1.5GB)
├── node:22-slim (digest-pinned)
├── System: build-essential, python3, git, openssh, dbus, gnome-keyring, libsecret
├── @anthropic-ai/claude-code@<pinned-version>
├── node-pty pre-compiled in /prebuilt/
└── init-keyring.sh

codeck (production, ~200MB on top of base)
├── npm install --omit=dev
├── Pre-built node-pty copied from /prebuilt/
├── dist/ (pre-built on host)
└── apps/runtime/src/templates/
```

### Docker Compose (`docker/compose.yml`)

Single service, single container:

```yaml
services:
  codeck:
    ports: ["127.0.0.1:8080:80"]
    environment:
      - CODECK_PORT=80
      - CODECK_NETWORK_MODE=bridge
      - CODECK_DIR=/workspace/.codeck
      - WORKSPACE=/workspace
    volumes:
      - codeck-workspace:/workspace
      - codeck-claude:/root/.claude
      - codeck-ssh:/root/.ssh
      - codeck-gh:/root/.config/gh
```

### Security hardening

```yaml
cap_drop: [ALL]
cap_add: [CHOWN, SETUID, SETGID, NET_BIND_SERVICE, KILL, DAC_OVERRIDE]
security_opt: [no-new-privileges:true]
pids_limit: 512
```

### Read-only filesystem

```yaml
tmpfs:
  - /tmp:size=512M,mode=1777
  - /run:size=100M,mode=0755
```

Writable: tmpfs mounts (ephemeral) + persistent volumes.

### Resource limits

```yaml
deploy:
  resources:
    limits:
      memory: ${CODECK_MEMORY_LIMIT:-0}
      pids: 512
    reservations:
      memory: 256M
```

### Health check

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:80/api/auth/status"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 10s
```

---

## Container filesystem at runtime

| Path | Purpose | Persistent? |
|------|---------|------------|
| `/workspace` | Projects and repos | Yes (volume) |
| `/workspace/.codeck` | Codeck data (auth, config, memory, rules, skills, agents) | Yes (volume) |
| `/root/.claude` | Claude CLI credentials, settings, MCP config | Yes (volume) |
| `/root/.ssh` | SSH keys | Yes (volume) |
| `/root/.config/gh` | GitHub CLI OAuth token | Yes (volume) |
| `/tmp` | Temporary files (npm cache, build artifacts) | No (tmpfs) |
| `/run` | Runtime state (PID files, sockets) | No (tmpfs) |

---

## Security model

### Encryption

- **OAuth tokens:** AES-256-GCM encrypted at rest in `.credentials.json`
- **Key derivation:** scrypt with fixed salt from `CODECK_ENCRYPTION_KEY` or hostname fallback
- **Unique IV:** 16-byte random IV per encryption operation

### File permissions

| File | Mode | Purpose |
|------|------|---------|
| `/workspace/.codeck/auth.json` | 0600 | Scrypt password hash |
| `/workspace/.codeck/sessions.json` | 0600 | Session tokens |
| `/root/.claude/.credentials.json` | 0600 | Encrypted OAuth tokens |
| `/root/.ssh/id_ed25519` | 0600 | SSH private key |

Directories: 0700 (owner read/write/execute only).

### Secret sanitization

All logs pass through `sanitizeSecrets()` covering 15+ patterns: Bearer tokens, API keys, JWTs, cloud provider keys (AWS, GitHub, Anthropic, etc.), database URIs, PEM private keys.

### Network isolation

Single-container architecture — all projects share one network namespace. No inter-project network isolation. Dev servers can access each other via localhost. Acceptable for single-user sandbox.

### Docker socket

Not mounted. Port exposure uses compose override files + helper containers for auto-restart, not Docker socket access.

---

## Caching and in-memory state

| Cache | TTL | Purpose |
|-------|-----|---------|
| Claude auth check | 3s | Avoid re-reading credentials on every API call |
| Claude usage | 60s | Rate limit Anthropic API calls |
| SSH test result | 30s | Avoid repeated `ssh -T` spawns |
| Git/gh CLI checks | permanent | Binary existence doesn't change at runtime |
| Session status | none | Real-time tracking of terminal activity |

---

## Concurrency & state management

### Session state mutations

Multiple concurrent operations (tab attach, login, permission update) access shared Maps. Boolean lock in `console.ts` prevents concurrent session creation.

### Memory indexer

- **WAL Mode:** Concurrent reads during indexing
- **Read-only search connection:** Queries don't block indexing
- **Transaction safety:** File indexing wrapped in atomic transactions
- **Reindex lock:** Application-level guard (returns 409 if already running)

### Proactive agent concurrency

- **Per-CWD locking:** Agents sharing same `cwd` execute sequentially
- **Different CWDs:** Run in parallel (no global cap)
- **FIFO queues:** Per-directory queues for pending agents
- **Max 10 agents total**

---

## Module dependencies

```
server.ts (Express app)
├── auth.ts (password auth)
├── auth-anthropic.ts (OAuth PKCE)
│   └── agent.ts (Claude CLI config)
├── console.ts (PTY sessions)
│   ├── claude-env.ts (binary resolution, OAuth env)
│   │   └── agent.ts
│   ├── permissions.ts (CLI permissions)
│   └── session-writer.ts (transcript capture)
├── git.ts (git operations facade)
│   ├── git/operations.ts
│   ├── git/github-auth.ts
│   ├── git/ssh.ts
│   └── git/workspace.ts
├── memory.ts (memory CRUD)
├── memory-indexer.ts (FTS5 indexing)
│   └── embeddings.ts (embedding provider)
├── memory-search.ts (FTS5 queries)
├── memory-context.ts (context injection)
├── memory-consolidation.ts (weekly consolidation pipeline)
├── proactive-agents.ts (scheduled agents)
│   └── claude-env.ts
├── teams.ts (team template CRUD)
├── tmux-bridge.ts (Agent Teams orchestration)
│   ├── tmux-pty-adapter.ts (IPty wrapper for tmux panes)
│   ├── console.ts (registerVirtualSession)
│   ├── teams.ts (saveTeamExecution)
│   └── claude-env.ts (getOAuthEnv)
├── conversation-storage.ts (chat conversation CRUD)
├── chat-api-handler.ts (Anthropic API streaming + tool loop)
│   ├── conversation-storage.ts
│   ├── claude-env.ts (getOAuthEnv)
│   └── web-tools.ts (web_search, web_fetch tool implementations)
├── cli-auth.ts (third-party CLI auth)
├── preset.ts (template system)
├── port-manager.ts (port exposure)
├── ports.ts (port scanner)
├── resources.ts (container metrics)
├── mdns.ts (LAN discovery)
├── agent-usage.ts (API usage tracking)
├── session-summarizer.ts (post-session summaries)
├── environment.ts (deployment detection)
└── logger.ts (log interception + WS broadcast)
```
