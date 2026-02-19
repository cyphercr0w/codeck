# Backend Services — Codeck Sandbox

All services are ES modules with pure functions (no classes). Mutable state is encapsulated in module-level variables.

## Runtime vs Daemon

Services are split across two processes:

- **Runtime services** (`apps/runtime/src/services/`) — All business logic: PTY, files, memory, agents, Claude auth, git, presets. Runs in both local and gateway mode.
- **Daemon services** (`apps/daemon/src/services/`) — Auth gating, rate limiting, audit logging, HTTP/WS proxy. Only runs in gateway mode.

The daemon has zero code imports from the runtime. Communication between them is HTTP/WS over the network.

---

## Daemon Services

### `daemon/services/auth.ts` — Daemon Password Authentication

Validates passwords against the shared `auth.json` (read-only — password setup/change is runtime-only). Manages its own session store.

| Function | Signature | Description |
|----------|-----------|-------------|
| `isPasswordConfigured` | `(): boolean` | Checks if `auth.json` exists with hash + salt |
| `validatePassword` | `(password, ip, deviceId): Promise<{success, token?, sessionId?, deviceId?}>` | Verify password (scrypt + legacy SHA256), create daemon session |
| `validateSession` | `(token): boolean` | Check token exists and not expired (7-day TTL) |
| `touchSession` | `(token): void` | Update `lastSeen` (debounced, saves every 60s) |
| `invalidateSession` | `(token): void` | Delete session, persist immediately |
| `getActiveSessions` | `(currentToken?): SessionInfo[]` | All non-expired sessions, sorted by `lastSeen` DESC |
| `revokeSessionById` | `(sessionId): boolean` | Delete by UUID |
| `getAuthLog` | `(): AuthLogEntry[]` | Last 200 login/failure events (in-memory circular) |

**Files:** Reads `CODECK_DIR/auth.json` (shared with runtime). Writes `CODECK_DIR/daemon-sessions.json` (daemon-only).

**Env vars:** `CODECK_DIR` (default `/workspace/.codeck`), `SESSION_TTL_MS` (default 604800000 = 7 days)

### `daemon/services/audit.ts` — Audit Logging

Append-only JSONL log for auth events.

| Function | Signature | Description |
|----------|-----------|-------------|
| `audit` | `(event, actor, opts?): void` | Queue audit entry. Flushes when buffer ≥ 20 or every 5s |
| `flushAudit` | `(): void` | Force-flush buffer to disk (call on shutdown) |

**Event types:** `auth.login`, `auth.login_failure`, `auth.logout`, `auth.session_revoked`

**Entry format:** `{ timestamp, event, sessionId, deviceId, actor (IP), metadata? }`

**File:** `CODECK_DIR/audit.log` (JSONL, mode 0600)

### `daemon/services/rate-limit.ts` — Rate Limiting

Per-IP sliding window rate limiter with brute-force lockout.

| Export | Description |
|--------|-------------|
| `createAuthLimiter()` | Returns `RateLimiter` — 10 req/min per IP |
| `createWritesLimiter()` | Returns `RateLimiter` — 60 req/min per IP |
| `checkLockout(ip)` | Returns `{locked, retryAfter?}` — check brute-force lockout |
| `recordFailedLogin(ip)` | Increment failure count for IP |
| `clearFailedAttempts(ip)` | Clear failures after successful login |

**Env vars:** `RATE_AUTH_MAX` (10), `RATE_AUTH_WINDOW_MS` (60000), `RATE_WRITES_MAX` (60), `RATE_WRITES_WINDOW_MS` (60000), `LOCKOUT_THRESHOLD` (5), `LOCKOUT_DURATION_MS` (900000)

### `daemon/services/proxy.ts` — HTTP Reverse Proxy

Forwards `/api/*` requests (not handled by daemon) to the runtime.

| Function | Signature | Description |
|----------|-----------|-------------|
| `proxyToRuntime` | `(req, res): void` | Forward request to runtime, stream response |
| `checkRuntime` | `(): Promise<boolean>` | Health check against runtime `/internal/status` |
| `getRuntimeUrl` | `(): string` | Return configured runtime URL |

**Behavior:** Strips `Authorization` header (daemon auth), adds `X-Forwarded-*` headers. Re-serializes `req.body` (consumed by `express.json()`). Returns 502 on connection error, 504 on timeout.

**Env vars:** `CODECK_RUNTIME_URL` (default `http://codeck-runtime:7777`), `PROXY_TIMEOUT_MS` (default 30000)

### `daemon/services/ws-proxy.ts` — WebSocket Proxy

Handles HTTP upgrade on the daemon, authenticates, and creates a bidirectional socket pipe to the runtime.

| Function | Signature | Description |
|----------|-----------|-------------|
| `handleWsUpgrade` | `(req, socket, head): void` | Validate token, proxy upgrade to runtime, pipe sockets |
| `shutdownWsProxy` | `(): void` | Close all connections, stop ping interval |
| `getWsConnectionCount` | `(): number` | Active connections (exposed in `/api/ui/status`) |

**Behavior:** Validates daemon session token from `?token=` query param. Strips token before proxying. Bidirectional pipe via `socket.pipe()`. WebSocket ping frames every 30s, stale cleanup at 75s. Max 20 concurrent connections.

**Env vars:** `CODECK_RUNTIME_WS_URL` (default = `CODECK_RUNTIME_URL`), `MAX_WS_CONNECTIONS` (20), `WS_PING_INTERVAL_MS` (30000)

---

## Runtime Services

---

## `services/agent.ts` — Claude CLI Configuration

Shared constants for Claude CLI binary paths, flags, and config file locations.

### Exports

| Export | Type | Description |
|--------|------|-------------|
| `ACTIVE_AGENT` | `const` | Configuration object: `{ id, name, command, flags, instructionFile, configDir, credentialsFile, configFile, settingsFile, projectsDir }` |

### Usage

Imported by `auth-anthropic.ts`, `claude-env.ts`, `console.ts`, `permissions.ts` for consistent Claude CLI paths across the service layer.

---

## `services/auth.ts` — Password Authentication

Single-user local auth using scrypt with salt. Legacy SHA-256 hashes are auto-migrated on successful login.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `isPasswordConfigured` | `(): boolean` | Checks if `/workspace/.codeck/auth.json` exists |
| `setupPassword` | `(password): Promise<{ success, token }>` | Creates auth.json with scrypt hash (64-byte key), **generates NEW session token** |
| `validatePassword` | `(password): Promise<{ success, token? }>` | Validates password with `timingSafeEqual`, **generates NEW session token** (session fixation prevention), auto-migrates legacy SHA-256 to scrypt |
| `changePassword` | `(current, new): Promise<{ success, error?, token? }>` | Verifies current password, hashes new password, **invalidates ALL sessions**, generates new token for requester |
| `validateSession` | `(token): boolean` | Checks token exists and has not expired (7-day TTL) |
| `invalidateSession` | `(token): void` | Removes single session from in-memory Map (manual logout) |

### Session Management

**Token Generation:**
- `setupPassword(password)` — Creates initial password hash + **NEW** random session token
- `validatePassword(password)` — Verifies password + generates **NEW** session token (session fixation prevention per OWASP)
- `changePassword(current, new)` — Invalidates **ALL** sessions + generates new token for requester

**Session Validation:**
- `validateSession(token)` — Checks token existence + TTL expiry (7 days)
- `invalidateSession(token)` — Manual logout (single session)

**Security Properties:**
- 256-bit random tokens via `crypto.randomBytes(32).toString('hex')`
- Session regeneration on authentication events (OWASP compliant — prevents session fixation)
- Atomic file writes to `sessions.json` (mode 0o600)
- Fixed 7-day TTL (no sliding window — user re-authenticates after expiry)
- Account lockout implemented in `server.ts` (5 failed attempts, 15-minute cooldown)

### State

- `activeSessions: Map<string, { createdAt: number }>` — In-memory Map, persisted to `/workspace/.codeck/sessions.json` (mode 0600) on every change and restored on startup. Expired sessions (>7-day TTL) are pruned during load.
- Disk: `/workspace/.codeck/auth.json` — `{ passwordHash, salt, algo, scryptCost }`, file mode 0600. `algo` is `'scrypt'` for new hashes or absent for legacy SHA-256. `scryptCost` tracks N parameter for opportunistic rehashing.

---

## `services/auth-anthropic.ts` — Claude OAuth PKCE

Manages Claude CLI authentication via manual OAuth PKCE flow.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `isClaudeInstalled` | `(): boolean` | Cached check for `claude --version` |
| `isClaudeAuthenticated` | `(): boolean` | 3s-cached check: env var → credentials.json → claude.json |
| `invalidateAuthCache` | `(): void` | Resets the 3s auth cache |
| `getLoginState` | `(): LoginState` | Returns current login state, cleans stale logins (>5min) |
| `startClaudeLogin` | `(callbacks): Promise<LoginResult>` | Generates PKCE values, builds OAuth URL, sets state |
| `cancelLogin` | `(): void` | Resets login state |
| `sendLoginCode` | `(code): Promise<SendCodeResult>` | Exchanges auth code for token, handles multiple code formats |
| `getAccountInfo` | `(): AccountInfo \| null` | Reads account info from .credentials.json |
| `getClaudeStatus` | `(): ClaudeStatus` | Composite: installed, authenticated, loginState, accountInfo |

### Auth check priority

1. `CLAUDE_CODE_OAUTH_TOKEN` environment variable
2. `/root/.claude/.credentials.json` file (`claudeAiOauth.accessToken`)
3. Legacy `/root/.claude.json` (`oauthAccount`) — returns false for keyring-based tokens

### Code format parsing

`sendLoginCode()` accepts:
- Raw code: `abc123`
- Direct token: `sk-ant-oat01-...` (saved directly, no exchange)
- Code with state: `abc123#state456` (extracts before `#`)
- Full URL: `https://...?code=abc123&state=...` (extracts `code` param)

---

## `services/agent-usage.ts` — Claude API Usage

Fetches quota/utilization data from the Anthropic API.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `getClaudeUsage` | `(): Promise<ClaudeUsage>` | Returns cached (60s TTL) usage data from Anthropic API |

### Response format

```typescript
{
  available: boolean;
  fiveHour?: { utilization: number; percent: number; resetsAt: string };
  sevenDay?: { utilization: number; percent: number; resetsAt: string };
}
```

### Token source

Reads OAuth token from `CLAUDE_CODE_OAUTH_TOKEN` env var or `.credentials.json`. Only accepts `sk-ant-oat01-*` tokens.

---

## `services/permissions.ts` — CLI Permission Management

Manages which Claude CLI tool permissions are pre-allowed without user confirmation.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `getPermissions` | `(): PermissionsMap` | Read permissions from config.json (defaults all `true`) |
| `setPermissions` | `(perms): PermissionsMap` | Update permissions, sync to settings.json |
| `syncToClaudeSettings` | `(): void` | Write enabled permissions to `~/.claude/settings.json` |

### Permission names

`Read`, `Edit`, `Write`, `Bash`, `WebFetch`, `WebSearch`

### Storage

- **Source of truth:** `/workspace/.codeck/config.json` field `permissions`
- **Synced to:** `/root/.claude/settings.json` field `permissions.allow`

### Integration with console.ts

`createConsoleSession()` calls `syncToClaudeSettings()` before each spawn to ensure `~/.claude/settings.json` reflects the current permission toggles.

---

## `services/console.ts` — PTY Session Management

Manages Claude CLI interactive pseudo-terminal sessions via node-pty.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `createConsoleSession` | `(options?): ConsoleSession` | Spawns claude CLI in PTY with OAuth env |
| `getSession` | `(id): ConsoleSession \| undefined` | Lookup by UUID |
| `getSessionCount` | `(): number` | Current active session count |
| `resizeSession` | `(id, cols, rows): void` | Resize PTY terminal |
| `writeToSession` | `(id, data): void` | Send input to PTY |
| `destroySession` | `(id): void` | Kill PTY and remove from Map |
| `destroyAllSessions` | `(): void` | Kill all sessions (graceful shutdown) |
| `markSessionAttached` | `(id): string[]` | Mark as attached, return buffered output |
| `renameSession` | `(id, name): boolean` | Rename session |
| `listSessions` | `(): SessionInfo[]` | List all sessions (without PTY reference) |
| `hasResumableConversations` | `(cwd): boolean` | Check for .jsonl files in claude projects dir |
| `saveSessionState` | `(reason, prompt?): SessionsState` | Save all active sessions to `.codeck/state/sessions.json` |
| `hasSavedSessions` | `(): boolean` | Check if saved sessions file exists |
| `restoreSavedSessions` | `(): SessionInfo[]` | Restore sessions from disk (agent=resume, shell=new) |
| `flushAllSessions` | `(timeout?): Promise<void>` | Write `/compact` to all agent PTYs before restart |
| `updateAgentBinary` | `(): { version, binaryPath }` | Run `npm install -g` to update Claude CLI, re-resolve binary path |

### Session creation flow

1. `getOAuthEnv()` — reads token from `.credentials.json`
2. `ensureOnboardingComplete()` — writes `hasCompletedOnboarding: true`, `hasTrustDialogAccepted: true` to `/root/.claude.json`
3. `syncToClaudeSettings()` — writes enabled permissions to `settings.json`
4. Build clean env: strip `NODE_ENV`, `PORT`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` from process.env; inject OAuth token + `TERM=xterm-256color`
5. `pty.spawn('claude', [--resume?], { name: 'xterm-256color', cols: 120, rows: 30, cwd, env })`
6. Output is buffered in `session.outputBuffer[]` (capped at 1MB, FIFO eviction) until a WebSocket client attaches
7. Transcript capture starts via `session-writer.ts`

**Note:** Shell sessions (`createShellSession`) do NOT require Claude authentication. Agent sessions do.

### ConsoleSession interface (internal)

```typescript
{
  id: string;              // UUID
  type: 'agent' | 'shell'; // Session type
  pty: IPty;               // node-pty instance
  cwd: string;             // Working directory
  name: string;            // Display name (default: basename of cwd)
  createdAt: number;       // Timestamp (ms)
  outputBuffer: string[];  // Buffered output before attach
  outputBufferSize: number; // Current buffer size in bytes
  attached: boolean;       // WebSocket client connected?
}
```

### PTY Process Termination

`destroySession(id)` sends SIGKILL immediately without SIGTERM grace period. Child processes cannot perform cleanup (flush buffers, close sockets, remove temp files).

**Future Enhancement:** Add SIGTERM → 2s grace period → SIGKILL pattern (matches proactive-agents termination).

### Output Buffering

Unattached sessions buffer PTY output in memory (1MB cap, LRU eviction). On WebSocket attach, buffered output is replayed to ensure client doesn't miss data during page refresh.

**Buffering Limits:**
- Max buffer size: 1MB per session
- Eviction policy: Drop oldest chunks when limit exceeded (FIFO)
- Buffer is cleared on attach (data replayed to client)

**Backpressure:** Currently NOT implemented between PTY output and WebSocket transmission. If client is slow, WebSocket send buffer grows unbounded. Future enhancement: implement pty.pause()/resume() based on xterm.js write callbacks.

---

## `web/logger.ts` — Console Log Interception

Intercepts `console.log`, `console.error`, `console.warn`, `console.info` globally and broadcasts to WebSocket clients.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `addLog` | `(type, message): void` | Adds log entry to circular buffer + broadcasts to WS clients |
| `getLogBuffer` | `(): LogEntry[]` | Returns current log buffer (max 100 entries) |
| `installLogInterceptor` | `(): void` | Patches console.* methods to route through `addLog()` |
| `broadcast` | `(data): void` | Sends JSON message to all connected WebSocket clients |
| `setWsClients` | `(clients): void` | Updates WebSocket client list for broadcast |

### Log Entry Format

```typescript
interface LogEntry {
  type: 'info' | 'error' | 'warn';
  message: string;    // Sanitized via sanitizeSecrets(), truncated to 10KB
  timestamp: number;
}
```

### State

- `logBuffer: LogEntry[]` — Circular buffer, max 100 entries, 10KB max per entry
- `wsClients: WebSocket[]` — Active WebSocket connections for broadcast

### Secret Sanitization

All logs pass through `sanitizeSecrets()` (imported from `session-writer.ts`) before buffering. Covers 15+ secret patterns including:
- Bearer tokens (`Bearer [REDACTED]`)
- API keys (`api_key=[REDACTED]`)
- JWTs (`[JWT_REDACTED]`)
- Cloud provider keys (AWS, DigitalOcean, HuggingFace, SendGrid, Anthropic, GitHub, GitLab, npm, Slack)
- Database URIs (`://[CREDENTIALS_REDACTED]@`)
- PEM private keys (`[PRIVATE_KEY_REDACTED]`)

See `session-writer.ts:31-59` for full pattern list.

---

## `services/git.ts` — Git & GitHub Integration

Handles git operations, GitHub CLI auth, SSH key management, and workspace CLAUDE.md generation.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `isGitInstalled` | `(): boolean` | Cached check |
| `isGhInstalled` | `(): boolean` | Cached check |
| `isGhAuthenticated` | `(): boolean` | Runs `gh auth status` (not cached) |
| `hasGitHubToken` | `(): boolean` | Checks `GITHUB_TOKEN` env var |
| `hasRepository` | `(): boolean` | Checks for `.git/` in workspace |
| `listRepositories` | `(): RepoInfo[]` | Lists repos at workspace root and first-level subdirs |
| `isWorkspaceEmpty` | `(): boolean` | True if no real project directories |
| `startGitHubFullLogin` | `(callbacks): Promise<boolean>` | Spawns `gh auth login --web`, captures device code |
| `toSSHUrl` | `(url): string` | Converts HTTPS to SSH URL format |
| `cleanWorkspace` | `(): boolean` | Deletes all workspace files |
| `cloneRepository` | `(url, token?, useSSH?): Promise<CloneResult>` | Full clone with token injection, SSH support |
| `getGitHubConfig` | `(): GitHubConfig` | Current GitHub config state |
| `hasSSHKey` | `(): boolean` | Checks `/root/.ssh/id_ed25519` |
| `generateSSHKey` | `(): { success, exists?, error? }` | Generates ed25519 key pair |
| `getSSHPublicKey` | `(): string \| null` | Returns public key content |
| `testSSHConnection` | `(): boolean` | SSH test to GitHub (30s cache) |
| `invalidateSSHCache` | `(): void` | Reset SSH test cache |
| `getGitStatus` | `(): GitStatus` | Comprehensive status object |
| `updateClaudeMd` | `(): boolean` | Generates/updates workspace CLAUDE.md with project list |
| `isValidGitUrl` | `(url): boolean` | Validates URLs against SSRF/Clone2Leak/flag injection (exported) |

### Security

- **`isValidGitUrl()`** — Validates URLs against SSRF (blocks private IPs: 10.x, 172.16-31.x, 192.168.x, 169.254.x, .local, .internal), Clone2Leak (rejects control characters 0x00-0x1f, 0x7f for CVE-2024-50349/CVE-2024-52006), and flag injection (validates protocol and format)
- **`createAskpassScript()`** — Token isolation via separate `.token` file (mode 0o600) read by script using `cat`, preventing shell interpolation (not exposed, internal)
- **`configureGitCredentials()`** — Writes to `~/.git-credentials` (mode 0o600) after successful clone, configures `credential.helper=store` (not exposed, internal)
- **`cleanupAskpass()`** — Removes temporary askpass script and token file (not exposed, internal)
- **All git commands** — Use `spawnSync()` with array args (no shell injection), `--` separator before positional args (prevents flag injection like `--upload-pack=cmd`)

**Credential Management:**
- Askpass tokens ephemeral (created during clone, cleaned after completion)
- Persistent tokens stored in `~/.git-credentials` as plaintext (protected by 0o600 file permissions)
- No token expiry validation (expired tokens cause authentication failures)
- Single credential per host (multi-account requires manual management)
- See AUDIT-84 for detailed credential management analysis

### Clone flow

1. Validate URL with `isValidGitUrl()` (rejects local paths, `--flags`, non-HTTP protocols, control chars, private IPs)
2. Extract repo name from URL
3. If `useSSH` and no SSH key → auto-generate key
4. If `useSSH` → convert URL to SSH format
5. If HTTPS with token → inject via `GIT_ASKPASS` env var (temp script, auto-cleaned)
6. `git clone --` into `/workspace/<repoName>` (uses spawn with array args)
7. Configure git credential helper with stored token
8. Update workspace CLAUDE.md

### CLAUDE.md template markers

`updateClaudeMd()` supports two marker formats:
- `{{PROJECTS_LIST}}` — mustache-style (root template)
- `<!-- PROJECTS_LIST ... -->` — HTML comment (preset templates)

---

## `services/preset.ts` — Preset Configuration

Manages template-based workspace configurations.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `listPresets` | `(): PresetManifest[]` | Scans presets directory, returns sorted list |
| `getPresetStatus` | `(): PresetStatus` | Reads active preset from `/workspace/.codeck/config.json` |
| `applyPreset` | `(presetId, force?): Promise<void>` | Applies preset (with inheritance chain) |

### PresetManifest

```typescript
{
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  icon: string;
  tags: string[];
  extends: string | null;
  files: { src: string; dest: string }[];
  directories: string[];
}
```

### Inheritance

- `extends` field points to parent preset ID
- Max depth: 5, circular reference detection via `Set<string>`
- Parent applied first (base files), child overwrites on top
- "Data files" (paths containing `/memory/`, ending in `preferences.md`, or containing `/rules/`) skip overwrite unless `force=true`

---

## `services/resources.ts` — Container Resource Monitoring

Monitors Docker container health metrics.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `getContainerResources` | `(): ContainerResources` | Snapshot of CPU, memory, disk, uptime, sessions, ports |

### Data sources

| Metric | Primary source | Fallback |
|--------|---------------|----------|
| CPU usage | `/sys/fs/cgroup/cpu.stat` (delta calculation) | `os.loadavg()[0]` / CPU cores |
| Memory | `/sys/fs/cgroup/memory.current` + `memory.max` | `os.totalmem() - os.freemem()` |
| Disk | `statfsSync('/workspace')` | — |
| Ports | `getActivePorts()` from ports service | — |
| Sessions | `getSessionCount()` from console service | — |
| Uptime | `Date.now() - processStartTime` | — |

---

## `services/mdns.ts` — mDNS Responder

Responds to mDNS queries for `codeck.local` and `*.codeck.local` with the host's LAN IP. Uses the `multicast-dns` library with `reuseAddr: true` to coexist with other mDNS listeners.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `startMdns` | `(): void` | Starts the mDNS responder (responds to A queries) |
| `stopMdns` | `(): void` | Destroys the mDNS responder socket |
| `getLanIP` | `(): string` | Returns the first non-internal, non-Docker IPv4 address |

### How it works

- Listens for mDNS queries on port 5353 (multicast)
- Responds to `A` record queries for `codeck.local` or any `*.codeck.local` subdomain
- Returns the host's LAN IP address (skips 172.x.x.x Docker bridge IPs)
- Uses `reuseAddr: true` to share the socket with other mDNS listeners (Brave, Steam, avahi, etc.)
- With `network_mode: host` (Linux), mDNS broadcasts reach the LAN directly
- In bridge mode (default), responses stay inside Docker — harmless but ineffective for LAN

### IP resolution priority

1. First non-internal IPv4 that doesn't start with `172.` (skips Docker bridge)
2. Any non-internal IPv4 (fallback)
3. `127.0.0.1` (last resort)

---

## `services/port-manager.ts` — Port Manager

Detects network mode, tracks exposed ports, and handles automatic port exposure via Docker Compose.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `initPortManager` | `(): void` | Read env vars, detect container ID, detect compose project info via Docker labels |
| `getNetworkMode` | `(): 'host' \| 'bridge'` | Current network mode |
| `getMappedPorts` | `(): number[]` | Sorted array of mapped ports |
| `isPortExposed` | `(port): boolean` | True if port is in mapped range (always true in host mode) |
| `getNetworkInfo` | `(): NetworkInfo` | Full network info (mode, mapped ports, container ID) |
| `getComposeInfo` | `(): ComposeInfo` | Compose project dir, service name, container image |
| `addMappedPort` | `(port): void` | Add a port to the in-memory mapped set |
| `writePortOverride` | `(ports): void` | Write `compose.override.yml` on host via helper container |
| `spawnComposeRestart` | `(): void` | Spawn a detached helper container that runs `docker compose up -d` |
| `canAutoRestart` | `(): boolean` | True if compose info is available for auto-restart |

### State

- `networkMode: 'host' | 'bridge'` — from `CODECK_NETWORK_MODE` env var
- `mappedPorts: Set<number>` — parsed from `CODECK_MAPPED_PORTS` (e.g., `80,3000-3009`)
- `containerId: string | null` — from `/proc/self/cgroup` or `HOSTNAME` env
- `composeProjectDir: string | null` — from Docker label `com.docker.compose.project.working_dir`
- `composeServiceName: string | null` — from Docker label `com.docker.compose.service`
- `containerImage: string | null` — from `docker inspect`

### Auto-restart flow

When `POST /api/system/add-port` is called in bridge mode with compose info available:
1. Generates `compose.override.yml` with new port mapping
2. Writes it to the host via a helper container (base64 pipe to avoid escaping)
3. Saves session state for auto-restore after restart
4. Responds immediately with `{ success: true, restarting: true }`
5. Spawns a detached helper container that runs `docker compose up -d` after 3s delay
6. The sandbox container gets recreated with new ports
7. New container starts, finds saved sessions, restores them with continuation prompts

---

## `services/ports.ts` — Port Scanner

Detects listening TCP ports inside the container with exposure status.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `getActivePorts` | `(): PortInfo[]` | Returns detected listening ports with exposure status |
| `startPortScanner` | `(): void` | Starts scanning every 5s, broadcasts changes via WS |
| `stopPortScanner` | `(): void` | Stops the scan interval |

### PortInfo

```typescript
interface PortInfo {
  port: number;
  exposed: boolean;  // from isPortExposed()
}
```

### How it works

Runs `ss -tlnp` every 5 seconds, parses the output for listening ports, checks exposure via `isPortExposed()`, and broadcasts `{ type: 'ports', data: PortInfo[] }` to all WebSocket clients when the list changes.

---

## `services/memory.ts` — Memory System

File-based persistence for durable memory, daily journals, ADRs, and path-scoped memory. All data lives in `/workspace/.codeck/memory/` (agent data) and `/workspace/.codeck/sessions/`, `/workspace/.codeck/index/`, `/workspace/.codeck/state/` (system data).

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `ensureDirectories` | `(): void` | Creates memory dirs if missing. Migrates summary.md → MEMORY.md, journal/ → daily/ |
| `getMemoryStatus` | `(): StatusInfo` | Memory system status with counts and last flush info |
| `listMemoryFiles` | `(): FileInfo[]` | List all memory files with metadata |
| `getDurableMemory` | `(pathId?): { exists, content }` | Read MEMORY.md (global or path-scoped) |
| `writeDurableMemory` | `(content, pathId?): void` | Overwrite MEMORY.md |
| `appendToDurableMemory` | `(section, entry, pathId?): void` | Append to specific `## Section` |
| `getDailyEntry` | `(date?, pathId?): { exists, date, content }` | Read daily entry for date (default: today) |
| `appendToDaily` | `(entry, pathId?, tags?): { date }` | Append timestamped entry to today's daily |
| `listDaily` | `(pathId?): { date, size }[]` | List daily files, newest first |
| `createDecision` | `(title, context, decision, consequences, pathId?): { filename }` | Create ADR with filename `ADR-YYYYMMDD-<slug>.md` |
| `listDecisions` | `(pathId?): DecisionItem[]` | List all ADRs (global or path-scoped) |
| `getDecision` | `(filename): { exists, content, filename }` | Read specific ADR by filename |
| `listPathScopes` | `(): PathMapping[]` | List all path scopes, newest first |
| `resolvePathId` | `(canonicalPath): string` | Resolve canonical path to pathId (auto-creates entry + directories, deterministic SHA-256 hash) |
| `getPathMapping` | `(pathId): PathMapping \| null` | Get mapping for a pathId (returns null if not found) |
| `computePathId` | `(canonicalPath): string` | Compute pathId from canonical path (SHA-256 truncated to 12 hex chars) |
| `sanitizePathId` | `(raw): string \| null` | Validate and sanitize pathId from untrusted input (allows only [a-f0-9]{12}) |
| `getPathMemory` | `(pathId): { exists, content }` | Read path-scoped MEMORY.md |
| `writePathMemory` | `(pathId, content): void` | Overwrite path-scoped MEMORY.md |
| `promoteToMemory` | `(request): void` | Promote content from daily/session to durable or ADR |
| `assembleContext` | `(pathId?): string` | Concatenate MEMORY.md + today's daily (global or path-scoped) |
| `flushToDaily` | `(content, pathId?, tags?): { date }` | Manual context flush to daily (rate-limited) |
| `canFlush` | `(): boolean` | Check if flush is allowed (rate limit check) |
| `getFlushState` | `(): FlushState` | Get flush rate-limit state |
| `getSummary` / `getDecisionsLegacy` | `(): { exists, content }` | Backward-compat for old endpoints |

### Directory layout

```
/workspace/.codeck/
  memory/
    MEMORY.md                    # Global durable memory
    summary.md                   # Legacy (read-only, migrated)
    decisions.md                 # Legacy (read-only, migrated)
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
  sessions/
    <session-id>.jsonl           # Session transcripts
  index/
    memory.sqlite                # SQLite FTS5 index
  state/
    paths.json                   # Path registry
    flush-state.json             # Flush rate-limit state
```

### Path-scoped memory

Paths are hashed using SHA-256 (first 12 characters) to create a `pathId`. The `paths.json` registry maps pathIds to canonical paths with creation timestamps. All memory operations accept an optional `pathId` parameter to scope data to a specific path.

**Security Note**: PathIds are 12-character SHA-256 truncations (48-bit hash space). Collision probability per birthday paradox is ~50% after 16.8M paths. In practice, collisions are rare for personal/team use but detection is recommended for production systems. See AUDIT-76 for details.

---

## `services/session-writer.ts` — Session Transcript Capture

Captures PTY I/O as structured JSONL files with ANSI stripping and secret sanitization. Session files are stored in `/workspace/.codeck/sessions/`.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `startSessionCapture` | `(id, cwd): void` | Create JSONL file at `.codeck/sessions/<id>.jsonl`, write start event |
| `captureInput` | `(id, data): void` | Buffer input, flush on newline or 2s debounce |
| `captureOutput` | `(id, data): void` | Strip ANSI, sanitize secrets, buffer, flush every 500ms/2KB |
| `endSessionCapture` | `(id): void` | Write end event, close stream |
| `onCompactionDetected` | `(cb): void` | Register callback for compaction detection |
| `listSessionFiles` | `(): SessionInfo[]` | List session transcript files from `.codeck/sessions/` |
| `readSessionTranscript` | `(id): { exists, lines }` | Read session JSONL |
| `getSessionSummary` | `(id): { exists, summary }` | Session metadata |

### JSONL format

```jsonl
{"ts":1707580800,"role":"system","event":"start","cwd":"/workspace/proj"}
{"ts":1707580810,"role":"input","data":"Help me implement search"}
{"ts":1707580815,"role":"output","data":"I'll help you..."}
{"ts":1707580900,"role":"system","event":"compaction_detected","pattern":"..."}
{"ts":1707580950,"role":"system","event":"end","lines":42}
```

### Secret sanitization

Before logging, all data passes through `sanitizeSecrets()` which redacts:
- Bearer tokens
- API keys, secrets, passwords (20+ char values after key-like names)
- JWTs (`eyJ...`)
- Platform-specific keys (sk_, ghp_, gho_, github_pat_, etc.)

---

## `services/memory-indexer.ts` — SQLite FTS5 Indexer

Indexes all memory files for full-text search. Uses `better-sqlite3` (optional dependency — gracefully degrades if not available). Database stored at `/workspace/.codeck/index/memory.sqlite`.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `initializeIndexer` | `(): Promise<boolean>` | Open DB at `.codeck/index/memory.sqlite`, create schema, initial index, start watcher |
| `shutdownIndexer` | `(): void` | Close DB, stop watcher |
| `indexAll` | `(): void` | Full re-index (hash-compare for efficiency) |
| `getIndexStats` | `(): Record<string, unknown>` | File count, chunk count, vec count, type breakdown |
| `isIndexerAvailable` | `(): boolean` | Whether SQLite is loaded |
| `isVecAvailable` | `(): boolean` | Whether sqlite-vec extension is loaded and embeddings are available |
| `processEmbeddingQueue` | `(): Promise<number>` | Process pending embedding queue (50 chunks per batch) |
| `getEmbeddingQueueSize` | `(): number` | Number of chunks waiting for embedding |

### Schema

- `files` table: path, type, hash (SHA-256), indexed_at, size
- `chunks` table: file_id, chunk_index, content, metadata (JSON)
- `chunks_fts` virtual table: FTS5 with porter + unicode61 tokenizer
- `chunks_vec` virtual table: sqlite-vec with FLOAT[384] embeddings (optional, requires sqlite-vec extension)
- Triggers keep FTS in sync with chunks on INSERT/UPDATE/DELETE

### Chunking

- Markdown: split on headings, ~1600 chars/chunk, 320 char overlap
- JSONL: 20 lines/chunk with extracted roles and timestamps

### File watcher

Uses `fs.watch()` recursive with 2s debounce to re-index changed files. Watches both `/workspace/.codeck/memory/` and `/workspace/.codeck/sessions/`.

### Concurrency & Safety

- **WAL Mode:** Enabled for concurrent reads during indexing (`journal_mode = WAL`)
- **Search Connection:** Read-only (`readonly: true`), allows queries during reindex without blocking
- **Transaction Safety:** File indexing wrapped in transactions (delete-old-insert-new atomic)
- **Cascading Deletes:** Foreign key constraints (`ON DELETE CASCADE`) prevent orphaned chunks
- **FTS5 Triggers:** Automatic FTS index sync on content table changes (INSERT/UPDATE/DELETE)
- **Reindex Lock:** Application-level guard prevents concurrent reindex operations (returns 409 if already running)
- **Optimize Strategy:** Runs after full reindex to merge index segments for faster queries

**Note:** FTS5 `optimize` can be CPU-intensive for large indexes and may temporarily slow concurrent search queries (2-3 second spikes during reindex).

---

## `services/memory-search.ts` — FTS5 + Hybrid Search

BM25-ranked full-text search across all memory files with path-scoping support. Supports hybrid BM25+vector search with Reciprocal Rank Fusion when embeddings and sqlite-vec are available.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `initializeSearch` | `(): Promise<boolean>` | Open DB in readonly mode from `.codeck/index/memory.sqlite` |
| `shutdownSearch` | `(): void` | Close DB |
| `search` | `(options): SearchResult[]` | FTS5 BM25 search with scope, date, pathId, and filters |
| `vectorSearch` | `(options): Promise<SearchResult[]>` | Vector similarity search using sqlite-vec |
| `hybridSearch` | `(options): Promise<SearchResult[]>` | Combined BM25 + vector with RRF merge (0.4 BM25 / 0.6 vector) |
| `isSearchAvailable` | `(): boolean` | Whether search is ready |

### SearchOptions

```typescript
{
  query: string;
  scope?: 'durable' | 'daily' | 'decision' | 'session';
  pathId?: string;      // Filter to specific path
  dateFrom?: string;    // YYYY-MM-DD
  dateTo?: string;      // YYYY-MM-DD
  project?: string;     // Filter by project in metadata
  limit?: number;       // Default: 20
}
```

### SearchResult

```typescript
{
  content: string;      // Full chunk content
  filePath: string;     // Relative path within memory dir
  fileType: string;     // durable|daily|decision|session
  metadata: Record<string, unknown>;
  rank: number;         // BM25 score
  snippet: string;      // FTS5 snippet with <mark> highlights
}
```

### Query Sanitization & Edge Cases

**Sanitization Strategy:**
- Terms split on whitespace (`\s+`), filtered for empty strings
- Each term wrapped in double quotes with embedded `"` doubled (e.g., `term"test` → `"term""test"*`)
- Prefix matching enabled via `*` suffix on all terms (e.g., `auth` matches `authenticate`, `authentication`)

**Edge Cases:**
- **Empty queries**: Return empty array without database call (early guard at line 65)
- **Special characters**: Automatically escaped via quote-doubling (e.g., `@`, `#`, `=`, `\` safe to search)
- **Boolean operators**: Not supported due to prefix-matching implementation; `auth AND session` treated as two prefix-match terms with implicit AND
- **Syntax errors**: Caught by try-catch, logged server-side, return empty array (no error exposed to users)
- **Very long queries**: No explicit length limit enforced (potential CPU cost for extremely long inputs)

**Security Properties:**
- All SQL uses prepared statements with parameterized queries (no SQL injection risk)
- FTS5 query constructed via string manipulation but parameterized before execution
- Error messages logged but not returned to API callers (prevents information leakage)

---

## `services/session-summarizer.ts` — Post-Session Auto-Summarization

When a session closes, parses the JSONL transcript and generates a template-based summary that gets appended to the daily memory log. No LLM required — pure parsing and heuristics.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `summarizeSession` | `(sessionId, cwd): Promise<void>` | Parse transcript, generate summary, save to daily (global + path-scoped) |
| `parseTranscriptForSummary` | `(lines, sessionId): TranscriptDigest` | Pure parsing: extract user inputs, file paths, errors, duration |
| `cleanupOldSessions` | `(maxAgeDays?): Promise<{deleted, errors}>` | Delete JSONL files older than N days (default 30) |

### Summary Contents

- Working directory and duration
- Files detected in output (`/workspace/...` paths)
- User inputs (truncated to 120 chars, max 8 shown)
- Error count, compaction count, transcript line count

### Skip Conditions

- Sessions shorter than 30 seconds (accidental opens)
- Transcripts with fewer than 3 lines

---

## `services/memory-context.ts` — Context Injection

When a new terminal session starts, gathers relevant memory context and injects it into `/workspace/CLAUDE.md` so Claude Code reads it automatically.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `buildSessionContext` | `(cwd): string` | Assemble context from daily entries, path memory, FTS search (~2000 chars max) |
| `injectContextIntoCLAUDEMd` | `(cwd): void` | Write `<!-- MEMORY_CONTEXT -->` section into workspace CLAUDE.md |

### Context Sources (priority order)

1. Today's global daily entries
2. Yesterday's global daily entries (if today is sparse)
3. Path-scoped durable memory (MEMORY.md for the project)
4. Path-scoped daily entries
5. FTS search results for project name (top 3)

### Injection

Uses marker comments (`<!-- MEMORY_CONTEXT_START -->` / `<!-- MEMORY_CONTEXT_END -->`) to replace only the memory section. Appends if markers don't exist yet.

---

## `services/embeddings.ts` — Embedding Provider

Provider abstraction for text embeddings. Gracefully degrades if no provider is available.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `initializeEmbeddings` | `(): Promise<boolean>` | Try local WASM, then Gemini fallback |
| `embed` | `(text): Promise<Float32Array \| null>` | Generate 384d embedding for text |
| `embedBatch` | `(texts): Promise<(Float32Array \| null)[]>` | Batch embed multiple texts |
| `isEmbeddingsAvailable` | `(): boolean` | Whether any provider is loaded |
| `getEmbeddingsProvider` | `(): string` | Active provider: `local-wasm`, `gemini`, or `none` |
| `getEmbeddingDim` | `(): number` | Embedding dimensions (384) |
| `shutdownEmbeddings` | `(): void` | Clean up resources |

### Providers

- **Local WASM** (`@xenova/transformers`): `Xenova/nomic-embed-text-v1.5`, 384d, quantized, no native compilation
- **Gemini** (fallback): `text-embedding-004` via free API tier, requires `GEMINI_API_KEY` env var

---

## `web/logger.ts` — Centralized Logging

Intercepts console output, sanitizes secrets, broadcasts to WebSocket clients.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `installLogInterceptor` | `(): void` | Monkey-patches `console.log`, `console.error`, `console.warn`, `console.info` |
| `addLog` | `(type, message): void` | Sanitize, buffer, broadcast |
| `getLogBuffer` | `(): LogEntry[]` | Returns full circular buffer (max 100) |
| `setWsClients` | `(clients): void` | Updates WS clients reference |
| `broadcast` | `(data): void` | Send to all open WS clients |

### Token sanitization

Regex patterns replaced with `***`:
- `sk-ant-oat01-*` (Anthropic OAuth tokens)
- `ghp_*` (GitHub personal access tokens)
- `ghu_*` (GitHub user tokens)

---

## `web/websocket.ts` — WebSocket Server

Real-time communication and PTY session multiplexing.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `setupWebSocket` | `(server): void` | Initialize WS server on HTTP server |
| `broadcastStatus` | `(): void` | Send current claude + git + preset status to all clients |

### Connection handling

1. Validate auth token from `?token=` query param
2. Add to clients array, update logger
3. Send initial `status` + `logs` messages
4. Handle incoming `console:attach`, `console:input`, `console:resize` messages
5. On disconnect, clean up client reference

### Session handler stacking prevention

Uses `sessionDisposables: Map<string, Disposable[]>` to track PTY event handlers per session. When re-attaching (e.g. page refresh), previous handlers are disposed first.

---

## `services/claude-env.ts` — Shared Claude CLI Helpers

Extracted from `console.ts` for reuse by `proactive-agents.ts`.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `resolveAgentBinary` | `(): string` | Find claude CLI binary via `which`/`where` or common paths |
| `getValidAgentBinary` | `(): string` | Return cached path or re-resolve if missing |
| `getAgentBinaryPath` | `(): string` | Get current cached binary path |
| `setAgentBinaryPath` | `(path): void` | Update cached binary path |
| `getOAuthEnv` | `(): Record<string, string>` | Read OAuth token from credentials file |
| `ensureOnboardingComplete` | `(): void` | Write onboarding flags to `.claude.json` |
| `buildCleanEnv` | `(): Record<string, string>` | Build env without Codeck-specific vars |

---

## `services/proactive-agents.ts` — Proactive Agents

Autonomous, scheduled agents using `claude -p` in non-interactive mode.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `initProactiveAgents` | `(broadcastFn): void` | Load manifest, restore agents, schedule crons |
| `shutdownProactiveAgents` | `(): void` | Stop crons, kill executions, save state |
| `createAgent` | `(input): AgentDetail` | Create and schedule a new agent |
| `getAgent` | `(id): AgentDetail \| null` | Get agent detail |
| `listAgents` | `(): AgentSummary[]` | List all agents |
| `updateAgent` | `(id, updates): AgentDetail \| null` | Update agent configuration |
| `deleteAgent` | `(id): boolean` | Delete agent and files |
| `pauseAgent` | `(id): AgentDetail \| null` | Pause agent (stop cron) |
| `resumeAgent` | `(id): AgentDetail \| null` | Resume agent (reset failures) |
| `triggerAgent` | `(id): { executionId } \| null` | Manual execution trigger (temporarily sets paused/error agents to 'active' for one-time execution without changing persisted state) |
| `getAgentLogs` | `(id): string \| null` | Latest execution log text |
| `getAgentExecutions` | `(id, limit?): ExecutionResult[]` | Execution history |

### State

- `agents: Map<string, AgentRuntime>` — In-memory runtime state per agent
- `cwdLocks: Map<string, string>` — Per-directory locks (cwd → agentId currently running)
- `cwdQueues: Map<string, string[]>` — Per-directory FIFO queues (cwd → queued agentIds)
- Files persisted to `/workspace/.codeck/agents/`

### Concurrency Model

**Per-CWD Locking (since commit 291a99b):**
- Agents sharing the same `cwd` execute sequentially (one at a time per directory)
- Agents with different `cwd` values run in parallel (no limit beyond MAX_AGENTS=10)
- Each `cwd` has a FIFO queue of pending agents
- Lock is acquired before execution (`cwdLocks.set(cwd, agentId)`), released on completion/error/timeout (`cwdLocks.delete(cwd)`)
- Server restart clears all locks and queues (fresh in-memory Maps)

**Resource Limits:**
- Max 10 agents total (`MAX_AGENTS`)
- No global concurrency cap (removed `MAX_CONCURRENT=2` in favor of per-CWD locking)
- Container limits (docker-compose) prevent resource exhaustion

### Execution flow

1. Cron fires → `enqueueExecution(agentId)`
2. Check if `cwd` is locked:
   - If locked → add to `cwdQueues[cwd]` (per-directory FIFO queue)
   - If unlocked → acquire lock (`cwdLocks.set(cwd, agentId)`) and execute
3. `spawn(claude, ['-p', objective, '--output-format', 'stream-json'])` with clean env + OAuth
4. Parse stdout as JSONL stream: extract text from `assistant` messages (`content[].text`), `content_block_delta` (`delta.text`), and `result` messages
5. Broadcast clean text via WS `agent:output` events for real-time UI streaming
6. Save raw JSONL to `{timestamp}.jsonl`, clean text to `{timestamp}.log`
7. Log PID, first chunk timing, byte counts, and stderr warnings
8. On close: release lock (`cwdLocks.delete(cwd)`), save result, update state, broadcast, process queue for the same `cwd` (`processCwdQueue(cwd)`)

### State Persistence

Agent configuration and state are persisted to disk under `/workspace/.codeck/agents/`:

```
.codeck/agents/
├── manifest.json          # Central registry: { version: 1, agents: [id1, id2, ...] }
└── <agentId>/
    ├── config.json        # AgentConfig: name, objective, schedule, cwd, timeouts
    ├── state.json         # AgentState: status, lastExecution, nextRun, failures
    └── executions/
        ├── 2026-02-14T10-30-00.jsonl      # Raw JSONL stream log
        ├── 2026-02-14T10-30-00.log        # Clean text output (sanitized)
        └── 2026-02-14T10-30-00.result.json # ExecutionResult metadata
```

**File Operations:**
- `manifest.json` — Written on agent create/delete (maps agent IDs for discovery)
- `config.json` — Written on agent create/update
- `state.json` — Written after each execution + cron tick (high frequency)
- Execution files — Written during/after each execution

**File Integrity:**
- All critical files (`manifest.json`, `config.json`, `state.json`) use atomic write-to-temp-then-rename via `atomicWriteFileSync()`
- Manifest is backed up to `manifest.json.backup` before each write
- On startup, manifest recovery tries: primary → backup → directory scan
- Config and state are validated against expected schema on load (type checks)
- Corrupt execution results logged with `console.warn` when skipped

**Startup Behavior:**
- Missing `manifest.json` → creates empty manifest `{ version: 1, agents: [] }`
- Corrupt manifest → falls back to `.backup`, then scans directories to recover agent list
- Missing/corrupt `config.json` or `state.json` → agent skipped with error log
- Invalid schema (wrong types, missing fields) → agent skipped with schema error log
- System always starts successfully, even if individual agents fail to load

**Execution History Retention:**
- Max 100 executions per agent (`MAX_EXECUTION_HISTORY`)
- Auto-pruned after each execution via `pruneExecutions()`
- Oldest results deleted first (FIFO)
- Corrupt execution results logged and skipped when queried

### Timeout & Termination

**Timeout Enforcement:**
- Default timeout: 5 minutes (300,000ms), configurable per agent via `timeoutMs` field
- Grace period: 15 seconds between SIGTERM and SIGKILL (configurable via `AGENT_SIGKILL_GRACE_MS` env var, clamped to 5–60s)
- Termination cascade: SIGTERM → wait 15s → SIGKILL (if process hasn't exited)
- Explicit boolean flag (`timedOut`) prevents race conditions in result classification

**Termination Behavior:**
- At timeout: `child.kill('SIGTERM')` sends polite shutdown request
- After 15s grace period: `child.kill('SIGKILL')` forces immediate termination
- Process reference check (`runtime.currentExecution === child`) prevents stale timeout handlers from affecting unrelated processes

**Exit Code Handling:**
- Exit code 0 + no timeout = `success`
- Non-zero exit code + no timeout = `failure`
- Any exit code + timeout flag set = `timeout`
- Spawn error (binary missing, permission denied) = `failure` with `exitCode: null`

**Zombie Prevention:**
- Node.js automatically consumes exit status via `close` event handlers
- Both `close` and `error` event handlers attached before spawning
- No manual `wait()` or `waitpid()` required
- Server restart clears any orphaned processes (in-memory state reset)
