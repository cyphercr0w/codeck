# Backend Services — Codeck Sandbox

All services are ES modules with pure functions (no classes). Mutable state is encapsulated in module-level variables. All services run in the single runtime process (`apps/runtime/`).

---

## `services/agent.ts` — Claude CLI Configuration

Shared constants for Claude CLI binary paths, flags, and config file locations.

### Exports

| Export | Type | Description |
|--------|------|-------------|
| `ACTIVE_AGENT` | `const` | Configuration object: `{ id, name, command, flags, instructionFile, configDir, credentialsFile, configFile, settingsFile, projectsDir }` |

### Usage

Imported by `auth-anthropic.ts`, `claude-env.ts`, `console.ts`, `permissions.ts`, `system.routes.ts` for consistent Claude CLI paths across the service layer.

---

## `services/auth.ts` — Password Authentication

Single-user local auth using scrypt with salt. Legacy SHA-256 hashes are auto-migrated on successful login.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `isPasswordConfigured` | `(): boolean` | Checks if `/workspace/.codeck/auth.json` exists |
| `setupPassword` | `(password): Promise<{ success, token }>` | Creates auth.json with scrypt hash (64-byte key), generates session token |
| `validatePassword` | `(password): Promise<{ success, token? }>` | Validates password with `timingSafeEqual`, generates new token (session fixation prevention), auto-migrates SHA-256 to scrypt |
| `changePassword` | `(current, new): Promise<{ success, error?, token? }>` | Verifies current, hashes new, invalidates ALL sessions, generates new token |
| `validateSession` | `(token): boolean` | Checks token exists and not expired (7-day TTL) |
| `invalidateSession` | `(token): void` | Removes single session |
| `getActiveSessions` | `(currentToken?): SessionInfo[]` | All non-expired sessions |
| `revokeSessionById` | `(sessionId): boolean` | Delete by UUID |
| `getAuthLog` | `(): AuthLogEntry[]` | Auth event history |
| `loadLockouts` / `saveLockouts` | `(): void` | Persist lockout state |
| `createWsTicket` | `(): string` | One-time WebSocket auth ticket |

### State

- `activeSessions: Map<string, { createdAt: number }>` — In-memory, persisted to `/workspace/.codeck/sessions.json` (mode 0600)
- Disk: `/workspace/.codeck/auth.json` — `{ passwordHash, salt, algo, scryptCost }` (mode 0600)

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
| `startClaudeLogin` | `(callbacks): Promise<LoginResult>` | Generates PKCE values, builds OAuth URL |
| `cancelLogin` | `(): void` | Resets login state |
| `sendLoginCode` | `(code): Promise<SendCodeResult>` | Exchanges auth code for token, handles multiple code formats |
| `getAccountInfo` | `(): AccountInfo \| null` | Reads account info from .credentials.json |
| `getClaudeStatus` | `(): ClaudeStatus` | Composite: installed, authenticated, loginState, accountInfo |
| `startTokenRefreshMonitor` | `(): void` | Background interval checking token expiry |
| `stopTokenRefreshMonitor` | `(): void` | Clear refresh interval |

### Auth check priority

1. `CLAUDE_CODE_OAUTH_TOKEN` environment variable
2. `/root/.claude/.credentials.json` file (`claudeAiOauth.accessToken`)
3. Legacy `/root/.claude.json` (`oauthAccount`)

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
| `getClaudeUsage` | `(): Promise<ClaudeUsage>` | Returns cached (60s TTL) usage data |

### Response format

```typescript
{
  available: boolean;
  fiveHour?: { utilization: number; percent: number; resetsAt: string };
  sevenDay?: { utilization: number; percent: number; resetsAt: string };
}
```

---

## `services/permissions.ts` — CLI Permission Management

Manages which Claude CLI tool permissions are pre-allowed and MCP server permissions.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `getPermissions` | `(): PermissionsMap` | Read basic permissions from config.json |
| `setPermissions` | `(perms): PermissionsMap` | Update basic permissions, sync to settings.json |
| `getMcpPermissions` | `(): McpPermissions` | Read MCP server allowed/denied state |
| `setMcpPermission` | `(name, allowed): McpPermissions` | Set MCP server permission |
| `getDenyRules` | `(): DenyRule[]` | Read deny rules |
| `syncToClaudeSettings` | `(): void` | Write all permissions to `~/.claude/settings.json` |

### Permission names

Basic: `Read`, `Edit`, `Write`, `Bash`, `WebFetch`, `WebSearch`

### Storage

- **Source of truth:** `/workspace/.codeck/config.json` field `permissions`
- **Synced to:** `/root/.claude/settings.json` fields `permissions.allow`, `permissions.deny`, `mcpServers`

---

## `services/console.ts` — PTY Session Management

Manages Claude CLI interactive pseudo-terminal sessions via node-pty.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `setupLanguageRules` | `(cwd): void` | Detects project language and symlinks matching ruleset from rules-library |
| `createConsoleSession` | `(options?): ConsoleSession` | Spawns claude CLI in PTY with OAuth env |
| `createShellSession` | `(options?): ConsoleSession` | Spawns bash shell (no OAuth required) |
| `getSession` | `(id): ConsoleSession \| undefined` | Lookup by UUID |
| `getSessionCount` | `(): number` | Active session count |
| `resizeSession` | `(id, cols, rows): void` | Resize PTY |
| `writeToSession` | `(id, data): void` | Send input to PTY |
| `destroySession` | `(id): void` | Kill PTY and cleanup |
| `destroyAllSessions` | `(): void` | Kill all (graceful shutdown) |
| `markSessionAttached` | `(id): string[]` | Mark attached, return buffered output |
| `renameSession` | `(id, name): boolean` | Rename session |
| `listSessions` | `(): SessionInfo[]` | List all sessions |
| `hasResumableConversations` | `(cwd): boolean` | Check for resumable sessions |
| `saveSessionState` | `(reason, prompt?): SessionsState` | Save sessions for auto-restore |
| `hasSavedSessions` | `(): boolean` | Check saved sessions exist |
| `restoreSavedSessions` | `(): SessionInfo[]` | Restore from disk |
| `flushAllSessions` | `(timeout?): Promise<void>` | Write `/compact` to all agent PTYs |
| `updateAgentBinary` | `(): { version, binaryPath }` | Update Claude CLI |
| `clearPendingRestore` | `(): void` | Clear pending restore state |

### Session creation flow

1. `getOAuthEnv()` — reads token from `.credentials.json`
2. `ensureOnboardingComplete()` — writes onboarding flags to `/root/.claude.json`
3. `setupLanguageRules(cwd)` — detects project language from indicator files and symlinks the matching ruleset from `/workspace/.codeck/rules-library/` into `~/.claude/rules/`
4. `syncToClaudeSettings()` — writes enabled permissions to `settings.json`
4. Build clean env: strip `NODE_ENV`, `PORT`, etc.; inject OAuth token + `TERM=xterm-256color`
5. `pty.spawn('claude', [--resume?], { name: 'xterm-256color', cols: 120, rows: 30, cwd, env })`
6. Output buffered in `session.outputBuffer[]` (1MB cap, FIFO) until WS client attaches
7. Transcript capture starts via `session-writer.ts`

### ConsoleSession interface

```typescript
{
  id: string;              // UUID
  type: 'agent' | 'shell'; // Session type
  pty: IPty;               // node-pty instance
  cwd: string;             // Working directory
  name: string;            // Display name
  createdAt: number;       // Timestamp (ms)
  outputBuffer: string[];  // Buffered output before attach
  outputBufferSize: number;
  attached: boolean;       // WebSocket client connected?
}
```

---

## `services/cli-auth.ts` — Third-Party CLI Authentication

Generic CLI-based OAuth device flow for services like Vercel.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `isValidService` | `(service): boolean` | Check service against allowlist |
| `getAuthState` | `(service): CLIAuthState` | Get current auth state |
| `startCLIAuth` | `(service, onUpdate?): CLIAuthState` | Start device flow |
| `cancelCLIAuth` | `(service): void` | Cancel in-progress login |
| `getSupportedCLIAuthServices` | `(): string[]` | List supported services |
| `isCLIAuthenticated` | `(service): Promise<{authenticated, username?}>` | Check if CLI is logged in |

### Supported services

Currently: `vercel` (via `vercel login --oob`)

### How it works

1. Spawns the CLI login command (`vercel login --oob`)
2. Captures device URL and code from stdout via regex
3. Tracks completion via success pattern matching
4. Frontend polls `/api/cli-auth/:service/status`
5. Timeout after 120s, cleanup on cancel

---

## `services/claude-env.ts` — Shared Claude CLI Helpers

Extracted from `console.ts` for reuse by `proactive-agents.ts`.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `resolveAgentBinary` | `(): string` | Find claude CLI binary via `which` or common paths |
| `getValidAgentBinary` | `(): string` | Return cached path or re-resolve |
| `getAgentBinaryPath` | `(): string` | Get cached binary path |
| `setAgentBinaryPath` | `(path): void` | Update cached path |
| `getOAuthEnv` | `(): Record<string, string>` | Read OAuth token from credentials |
| `ensureOnboardingComplete` | `(): void` | Write onboarding flags to `.claude.json` |
| `buildCleanEnv` | `(): Record<string, string>` | Build env without Codeck-specific vars |

---

## `web/logger.ts` — Console Log Interception

Intercepts `console.log`, `console.error`, `console.warn`, `console.info` globally and broadcasts to WebSocket clients.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `addLog` | `(type, message): void` | Adds log entry to circular buffer + broadcasts to WS |
| `getLogBuffer` | `(): LogEntry[]` | Returns current buffer (max 100) |
| `installLogInterceptor` | `(): void` | Patches console.* methods |
| `broadcast` | `(data): void` | Sends JSON to all WS clients |
| `setWsClients` | `(clients): void` | Updates WS client list |

### Secret Sanitization

All logs pass through `sanitizeSecrets()` (from `session-writer.ts`). Covers 15+ patterns including Bearer tokens, API keys, JWTs, cloud provider keys, database URIs, PEM private keys.

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
| `listRepositories` | `(): RepoInfo[]` | Lists repos in workspace |
| `isWorkspaceEmpty` | `(): boolean` | No real project directories |
| `startGitHubFullLogin` | `(callbacks): Promise<boolean>` | Device code login via `gh` |
| `toSSHUrl` | `(url): string` | HTTPS to SSH URL |
| `cloneRepository` | `(url, token?, useSSH?): Promise<CloneResult>` | Full clone with token/SSH |
| `getGitStatus` | `(): GitStatus` | Comprehensive status |
| `updateClaudeMd` | `(): boolean` | Updates workspace CLAUDE.md with project list |
| `initGitHub` | `(): void` | Initialize GitHub config |
| `hasSSHKey` / `generateSSHKey` / `getSSHPublicKey` / `testSSHConnection` | — | SSH key management |
| `isValidGitUrl` | `(url): boolean` | Validates against SSRF/Clone2Leak/flag injection |

### Security

- `isValidGitUrl()` blocks private IPs, control characters, flag injection
- `createAskpassScript()` isolates tokens via separate `.token` file (mode 0o600)
- All git commands use `spawnSync()` with array args (no shell injection)

### Clone flow

1. Validate URL with `isValidGitUrl()`
2. Extract repo name
3. If SSH and no key → auto-generate
4. If HTTPS with token → inject via `GIT_ASKPASS`
5. `git clone --` into `/workspace/<repoName>`
6. Configure git credential helper
7. Update workspace CLAUDE.md

---

## `services/preset.ts` — Preset Configuration

Manages template-based workspace configurations.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `listPresets` | `(): PresetManifest[]` | Scans presets directory |
| `getPresetStatus` | `(): PresetStatus` | Reads active preset from config.json |
| `applyPreset` | `(presetId, force?): Promise<void>` | Applies preset with inheritance chain |

### Inheritance

- `extends` field points to parent preset ID
- Max depth: 5, circular reference detection
- Parent applied first, child overwrites on top
- "Data files" skip overwrite unless `force=true`

---

## `services/resources.ts` — Container Resource Monitoring

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `getContainerResources` | `(): ContainerResources` | CPU, memory, disk, uptime, sessions, ports |

### Data sources

| Metric | Primary source | Fallback |
|--------|---------------|----------|
| CPU usage | `/sys/fs/cgroup/cpu.stat` | `os.loadavg()[0]` |
| Memory | `/sys/fs/cgroup/memory.current` + `memory.max` | `os.totalmem()` |
| Disk | `statfsSync('/workspace')` | — |
| Ports | `getActivePorts()` | — |
| Sessions | `getSessionCount()` | — |

---

## `services/mdns.ts` — mDNS Responder

Responds to mDNS queries for `codeck.local` and `*.codeck.local`.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `startMdns` | `(): void` | Starts mDNS responder |
| `stopMdns` | `(): void` | Destroys responder socket |
| `getLanIP` | `(): string` | First non-internal, non-Docker IPv4 |

### IP resolution priority

1. First non-internal IPv4 not starting with `172.`
2. Any non-internal IPv4
3. `127.0.0.1` (last resort)

---

## `services/port-manager.ts` — Port Manager

Detects network mode, tracks exposed ports, handles auto port exposure via Docker Compose.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `initPortManager` | `(): void` | Read env vars, detect container ID, compose project info |
| `getNetworkMode` | `(): 'host' \| 'bridge'` | Current mode |
| `getMappedPorts` | `(): number[]` | Sorted mapped ports |
| `isPortExposed` | `(port): boolean` | In mapped range (always true in host mode) |
| `getNetworkInfo` | `(): NetworkInfo` | Full network info |
| `getComposeInfo` | `(): ComposeInfo` | Compose project dir, service name, image |
| `addMappedPort` / `removeMappedPort` | `(port): void` | Modify in-memory set |
| `writePortOverride` | `(ports): void` | Write compose.override.yml via helper container |
| `spawnComposeRestart` | `(): void` | Detached helper container runs `docker compose up -d` |
| `canAutoRestart` | `(): boolean` | Compose info available |
| `getCodeckPort` | `(): number` | Main Codeck port |

---

## `services/ports.ts` — Port Scanner

Detects listening TCP ports with exposure status.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `getActivePorts` | `(): PortInfo[]` | Detected ports with exposure status |
| `startPortScanner` | `(): void` | Scan every 5s, broadcast changes |
| `stopPortScanner` | `(): void` | Stop interval |

Runs `ss -tlnp`, parses for listening ports, checks exposure via `isPortExposed()`.

---

## `services/memory.ts` — Memory System

File-based persistence for durable memory, daily journals, ADRs, and path-scoped memory.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `ensureDirectories` | `(): void` | Creates dirs, migrates legacy files |
| `getMemoryStatus` | `(): StatusInfo` | Status with counts and flush info |
| `listMemoryFiles` | `(): FileInfo[]` | All memory files |
| `getDurableMemory` / `writeDurableMemory` / `appendToDurableMemory` | — | MEMORY.md CRUD |
| `getDailyEntry` / `appendToDaily` / `listDaily` | — | Daily entry CRUD |
| `createDecision` / `listDecisions` / `getDecision` | — | ADR CRUD |
| `listPathScopes` / `resolvePathId` / `getPathMapping` | — | Path scope management |
| `computePathId` / `sanitizePathId` | — | PathId utilities |
| `getPathMemory` / `writePathMemory` | — | Path-scoped MEMORY.md |
| `promoteToMemory` | `(request): void` | Promote content to durable or ADR |
| `assembleContext` | `(pathId?): string` | Concatenate MEMORY.md + daily |
| `flushToDaily` / `canFlush` / `getFlushState` | — | Rate-limited flush |

### Path-scoped memory

Paths hashed with SHA-256 (first 12 chars) to create `pathId`. Registry in `paths.json`.

---

## `services/session-writer.ts` — Session Transcript Capture

Captures PTY I/O as structured JSONL with ANSI stripping and secret sanitization.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `startSessionCapture` | `(id, cwd): void` | Create JSONL file, write start event |
| `captureInput` | `(id, data): void` | Buffer input, flush on newline or 2s |
| `captureOutput` | `(id, data): void` | Strip ANSI, sanitize secrets, buffer, flush |
| `endSessionCapture` | `(id): void` | Write end event, close stream |
| `onCompactionDetected` | `(cb): void` | Register compaction callback |
| `listSessionFiles` / `readSessionTranscript` / `getSessionSummary` | — | Read transcripts |

### JSONL format

```jsonl
{"ts":1707580800,"role":"system","event":"start","cwd":"/workspace/proj"}
{"ts":1707580810,"role":"input","data":"Help me implement search"}
{"ts":1707580815,"role":"output","data":"I'll help you..."}
{"ts":1707580900,"role":"system","event":"compaction_detected","pattern":"..."}
{"ts":1707580950,"role":"system","event":"end","lines":42}
```

---

## `services/memory-indexer.ts` — SQLite FTS5 Indexer

Indexes all memory files for full-text search.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `initializeIndexer` | `(): Promise<boolean>` | Open DB, create schema, initial index, start watcher |
| `shutdownIndexer` | `(): void` | Close DB, stop watcher |
| `indexAll` | `(): void` | Full re-index (hash-compare) |
| `getIndexStats` | `(): Record` | File count, chunk count, vec count |
| `isIndexerAvailable` | `(): boolean` | SQLite loaded |
| `isVecAvailable` | `(): boolean` | sqlite-vec loaded |
| `processEmbeddingQueue` | `(): Promise<number>` | Process pending embeddings (50/batch) |
| `getEmbeddingQueueSize` | `(): number` | Pending embedding count |

### Schema

- `files` table: path, type, hash, indexed_at, size
- `chunks` table: file_id, chunk_index, content, metadata
- `chunks_fts` virtual table: FTS5 (porter + unicode61 tokenizer)
- `chunks_vec` virtual table: sqlite-vec FLOAT[384] (optional)

### Chunking

- Markdown: split on headings, ~1600 chars/chunk, 320 char overlap
- JSONL: 20 lines/chunk with extracted roles and timestamps

---

## `services/memory-search.ts` — FTS5 + Hybrid Search

BM25-ranked full-text search with optional vector hybrid.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `initializeSearch` | `(): Promise<boolean>` | Open DB readonly |
| `shutdownSearch` | `(): void` | Close DB |
| `search` | `(options): SearchResult[]` | FTS5 BM25 search |
| `vectorSearch` | `(options): Promise<SearchResult[]>` | Vector similarity |
| `hybridSearch` | `(options): Promise<SearchResult[]>` | BM25 + vector with RRF (0.4/0.6) |
| `isSearchAvailable` | `(): boolean` | Ready state |

### Query sanitization

- Terms split on whitespace, wrapped in double quotes, prefix-matched with `*`
- Empty queries return empty array without DB call
- All SQL uses prepared statements (no injection risk)

---

## `services/memory-consolidation.ts` — Memory Consolidation Pipeline

Orchestrates weekly consolidation:

1. Run memory-consolidation.mjs (Haiku extraction → pending-consolidation.md)
2. Run consolidation-apply.mjs (apply suggestions to durable memory)
3. Run consolidation-decay.mjs (Ebbinghaus decay on WARM tier)
4. Run generate-weekly-digest.mjs (weekly stats digest)

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `initConsolidationCron` | `(): void` | Start weekly cron (Sunday 02:00 UTC) |
| `shutdownConsolidationCron` | `(): void` | Stop cron |
| `runConsolidation` | `(): Promise<ConsolidationResult>` | Manual trigger |
| `getConsolidationStatus` | `(): ConsolidationStatus` | Last run info |

### State

- `cronJob` — node-cron scheduled task
- `isRunning` — mutex preventing concurrent runs
- Persisted: consolidation-state.json, consolidation-audit.json, decay-state.json

---

## `services/memory-context.ts` — Context Injection

Injects relevant memory context into `/workspace/CLAUDE.md` when a terminal session starts.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `buildSessionContext` | `(cwd): string` | Assemble context (~2000 chars max) |
| `injectContextIntoCLAUDEMd` | `(cwd): void` | Write context into CLAUDE.md |

### Context sources (priority order)

1. Today's global daily entries
2. Yesterday's daily entries (if today sparse)
3. Path-scoped durable memory
4. Path-scoped daily entries
5. FTS search results for project name (top 3)

Uses `<!-- MEMORY_CONTEXT_START -->` / `<!-- MEMORY_CONTEXT_END -->` markers.

---

## `services/session-summarizer.ts` — Post-Session Auto-Summarization

Parses JSONL transcripts and generates template-based summaries for daily memory. No LLM required.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `summarizeSession` | `(sessionId, cwd): Promise<void>` | Parse, summarize, save to daily |
| `parseTranscriptForSummary` | `(lines, sessionId): TranscriptDigest` | Extract inputs, paths, errors |
| `cleanupOldSessions` | `(maxAgeDays?): Promise` | Delete old JSONL files |

Skips sessions shorter than 30s or fewer than 3 lines.

---

## `services/embeddings.ts` — Embedding Provider

Provider abstraction for text embeddings.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `initializeEmbeddings` | `(): Promise<boolean>` | Try local WASM, then Gemini fallback |
| `embed` | `(text): Promise<Float32Array \| null>` | Generate 384d embedding |
| `embedBatch` | `(texts): Promise` | Batch embed |
| `isEmbeddingsAvailable` | `(): boolean` | Any provider loaded |
| `getEmbeddingsProvider` | `(): string` | Active: `local-wasm`, `gemini`, or `none` |
| `getEmbeddingDim` | `(): number` | 384 |
| `shutdownEmbeddings` | `(): void` | Clean up |

### Providers

- **Local WASM** (`@xenova/transformers`): `Xenova/nomic-embed-text-v1.5`, 384d, quantized
- **Gemini** (fallback): `text-embedding-004` via free API tier, requires `GEMINI_API_KEY`

---

## `services/environment.ts` — Environment Detection

Detects deployment mode at startup:

1. If `/.dockerenv` exists → `docker`
2. Otherwise → `local`

Sets appropriate defaults for workspace path and port.

---

## `services/memory-stats.ts` — Memory Statistics

Provides detailed memory system statistics for the dashboard.

---

## `web/websocket.ts` — WebSocket Server

Real-time communication and PTY session multiplexing.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `setupWebSocket` | `(server): void` | Initialize WS on HTTP server |
| `handleWsUpgrade` | `(req, socket, head): void` | Handle WS upgrade with auth |
| `broadcastStatus` | `(): void` | Send claude + git + preset status to all clients |

### Connection handling

1. Validate auth token from `?token=` query param or subprotocol
2. Validate Origin header against allowed origins
3. Add to clients array, update logger
4. Send initial `status` + `logs` messages
5. Handle `console:attach`, `console:input`, `console:resize`
6. On disconnect, clean up

### Session handler stacking prevention

Uses `sessionDisposables: Map<string, Disposable[]>` to track PTY event handlers. Previous handlers disposed on re-attach.

---

## `web/internal-pty.ts` — Internal PTY WebSocket

Dedicated per-session PTY WebSocket connections at `/internal/pty/:id`.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `setupInternalPty` | `(server): void` | Initialize internal PTY WS server |
| `handlePtyUpgrade` | `(req, socket, head): void` | Handle PTY-specific WS upgrade |

---

## `services/git/*` — Source Control & GitHub

`operations.ts` adds `getGitDiff(cwd, {staged,base})` (unified diff for the review
loop, cwd validated within the workspace) and `getRepoRemote(cwd)` (`git remote
get-url origin` → `{owner,repo}`). New `git/github-api.ts` shells `gh api` (reuses
the keyring credential — no octokit): `listGitHubRepos()`, `listPullRequests()`,
`listIssues()`. All re-exported through the `services/git.ts` facade. See
[`docs/design/ORCA-PARITY.md`](design/ORCA-PARITY.md).

`playwright-screencast.ts` adds `inspectElementAt(x,y)` — Design Mode's CDP
`DOM.getNodeForLocation` → `{tag,selector,outerHTML,url}`.

## `services/proactive-agents.ts` — Proactive Agents

Autonomous, scheduled agents using `claude -p` in non-interactive mode.

### Exports

| Function | Signature | Description |
|----------|-----------|-------------|
| `initProactiveAgents` | `(broadcastFn): void` | Load manifest, restore agents, schedule crons |
| `shutdownProactiveAgents` | `(): void` | Stop crons, kill executions |
| `createAgent` / `getAgent` / `listAgents` / `updateAgent` / `deleteAgent` | — | CRUD |
| `pauseAgent` / `resumeAgent` | — | Lifecycle control |
| `triggerAgent` | `(id): { executionId }` | Manual trigger |
| `getAgentLogs` / `getAgentExecutions` | — | History and logs |
| `getLoopAcceptance` | `(id): LoopAcceptance \| null` | Loop only — cost per accepted change |
| `getLoopInbox` / `getLoopInboxEntry` | — | Loop only — escalations needing a human |

### Scheduled loops (`kind:'loop'`)

A loop agent runs the full PO-driven **autonomous-harness** on each cron tick
(see [`docs/design/SCHEDULED-LOOPS.md`](design/SCHEDULED-LOOPS.md)) instead of a
one-shot `claude -p`. `executor.ts`'s `buildLoopRun()` bootstraps an **isolated**
control-plane under `<agentDir>/{harness,state}` and passes `CODECK_HARNESS_DIR`
/ `CODECK_STATE_DIR` to the headless run so budget-guard, workflow-checkpoint,
no-progress-guard, review-marker and harness-resume operate there — never
colliding with an interactive harness task. The plan is pre-approved
(`planApproved:true`); the PO governs REVIEW/AUDIT/DONE. `readLoopOutcome()` reads
`overseer.json`/`budget.json` back after the tick for the acceptance metric.
Escalations land in `<agentDir>/inbox/`. Loops validate a required `goal` +
`verifyCmd` (a machine gate) and default to a 30-min (≤2h) timeout.

### Concurrency model

- **Per-CWD locking:** Same `cwd` → sequential execution
- **Different CWDs:** Parallel (no global cap)
- **FIFO queues:** Per-directory pending queue
- **Max 10 agents total**

### Execution flow

1. Cron fires → enqueue
2. Check CWD lock → acquire or queue
3. `spawn(claude, ['-p', objective, '--output-format', 'stream-json'])` with clean env
4. Parse stdout JSONL → extract text → broadcast via WS
5. Save raw JSONL + clean text log
6. On close: release lock, save result, process queue

### State persistence

```
.codeck/agents/
├── manifest.json          # Central registry
└── <agentId>/
    ├── config.json        # Name, objective, schedule, cwd, timeouts
    ├── state.json         # Status, lastExecution, nextRun, failures
    └── executions/
        ├── 2026-02-14T10-30-00.jsonl
        ├── 2026-02-14T10-30-00.log
        └── 2026-02-14T10-30-00.result.json
```

### Timeout & termination

- Default: 5 minutes, configurable per agent
- Grace period: 15s between SIGTERM and SIGKILL
- Exit code 0 = success, non-zero = failure, timeout flag = timeout

---

## `services/teams.ts` — Agent Team Templates

CRUD for team templates. Teams define parallel agent groups (no sequential transitions). Stored as JSON in `/workspace/.codeck/teams/templates/`.

### Exports

- `listTeamTemplates()` → `TeamTemplate[]`
- `getTeamTemplate(id)` → `TeamTemplate | null`
- `createTeamTemplate(data)` → `TeamTemplate`
- `updateTeamTemplate(id, data)` → `TeamTemplate | null`
- `deleteTeamTemplate(id)` → `boolean`
- `saveTeamExecution(execution)` → void
- `getTeamExecution(id)` → `TeamExecution | null`
- `listTeamExecutions()` → `TeamExecution[]`
- `initTeamTemplates()` — creates built-in templates (Security Audit, Code Review)

---

## `services/tmux-bridge.ts` — Agent Teams Orchestration

**Note:** The tmux-bridge was the original Agent Teams orchestration layer. It has been superseded by the native Agent/SendMessage system where Claude Code itself manages teams (implicit teams since 2.1.178 — `TeamCreate`/`TeamDelete` removed). The tmux-bridge remains for reference but is no longer the active launch path.

The current Agent Teams flow uses `console.ts` → `--append-system-prompt` to inject team leader instructions when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set. `teammate-watcher.ts` monitors for tmux panes created by Claude's Agent tool.

---

## `services/tmux-pty-adapter.ts` — IPty Wrapper for tmux Panes

Implements the IPty interface by wrapping tmux commands. Allows tmux panes to be registered as console sessions using the existing WebSocket pipeline.

- **Output**: `tmux pipe-pane -O` → temp file → `tail -f` → `onData()` callbacks
- **Input**: `tmux send-keys -t pane -l` for literals, special key mapping for Enter/Ctrl+C/arrows
- **Resize**: `tmux resize-pane -t pane -x cols -y rows`
- **Liveness**: polls `tmux display-message` every 5s, auto-destroys on pane death
- **Cleanup**: stops pipe-pane, kills tail process, removes temp file

---

## `services/conversation-storage.ts` — Chat Conversation Storage

File-based CRUD for chat conversations. Each conversation stored as a JSON file in `/workspace/.codeck/chat/conversations/`.

### Exports

- `ensureConversationsDir()` — creates conversations directory
- `readConversation(id)` → `ChatConversation | null`
- `writeConversation(conversation)` → void
- `deleteConversation(id)` → void
- `conversationPath(id)` → string — validated file path
- `listAllConversations()` → `ConversationSummary[]`
- `autoName(message)` → string — generates conversation name from first message

### Constants

- `MODEL_MAP` — maps client model names (haiku/sonnet/opus) to Anthropic API model IDs

---

## `services/chat-api-handler.ts` — Chat Streaming Handler

Calls the Anthropic Messages API directly with streaming, web tools, and an agentic tool loop (max 5 rounds).

### Exports

- `handleApiDirectMode(res, params)` — SSE streaming response handler

### How it works

1. Reads OAuth token from credentials
2. Builds message history from conversation
3. Calls Anthropic Messages API with streaming
4. Parses SSE stream, forwards text deltas to client
5. Executes tool calls (web_search, web_fetch) and loops back to API
6. Saves assistant response to conversation on completion
