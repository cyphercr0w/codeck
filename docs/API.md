# API Reference — Codeck Sandbox

All endpoints are served at `/api/` (relative to the host). In local mode, the runtime handles everything on port 80. In gateway mode, the daemon on port 8080 handles auth routes and proxies everything else to the runtime.

All protected endpoints require `Authorization: Bearer <token>` header (or `?token=<token>` for download links).

---

## Daemon Routes (Gateway Mode Only)

These routes are handled directly by the daemon in gateway mode. They do not exist in local mode (runtime handles auth instead).

| Method | Endpoint | Auth? | Body | Response | Description |
|--------|----------|-------|------|----------|-------------|
| `GET` | `/api/ui/status` | No | — | `{ status, mode, uptime, wsConnections }` | Daemon health check |
| `GET` | `/api/auth/status` | No | — | `{ configured: boolean }` | Check if password is set up |
| `POST` | `/api/auth/login` | No | `{ password, deviceId? }` | `{ success, token }` or `{ error }` | Create daemon session. Rate limited (10/min). Lockout after 5 failures (15 min). |
| `POST` | `/api/auth/logout` | Yes | — | `{ success }` | Invalidate daemon session token |
| `GET` | `/api/auth/sessions` | Yes | — | `SessionInfo[]` | List active daemon sessions (sorted by lastSeen DESC) |
| `DELETE` | `/api/auth/sessions/:id` | Yes | — | `{ success }` or 404 | Revoke a specific session |
| `GET` | `/api/auth/log` | Yes | — | `AuthLogEntry[]` | Auth event history (last 200 entries) |

All other `/api/*` requests are proxied to the runtime with `X-Forwarded-For/Proto/Host` headers. The daemon strips its own `Authorization` header before proxying.

---

## Runtime Authentication (Public)

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/auth/status` | — | `{ configured: boolean }` | Check if password is set up |
| `POST` | `/api/auth/setup` | `{ password }` | `{ success, token }` | Set initial password (min 8, max 256 chars, one-time) |
| `POST` | `/api/auth/login` | `{ password }` | `{ success, token }` or `{ error }` | Login with password. Locked out for 15 min after 5 failures. |

## Runtime Authentication (Protected)

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `POST` | `/api/auth/logout` | — | `{ success }` | Invalidate current session token |
| `POST` | `/api/auth/change-password` | `{ currentPassword, newPassword }` | `{ success, token }` or `{ error }` | Change password. Invalidates all sessions. |

---

## Status (Protected)

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/status` | — | `{ claude, git, preset }` | Combined system status |
| `GET` | `/api/logs` | — | `LogEntry[]` | In-memory log buffer (max 100 entries) |
| `GET` | `/api/account` | — | `{ authenticated, email?, org?, uuid? }` | Claude account info |

---

## Claude Authentication

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `POST` | `/api/claude/login` | — | `{ started, url? }` or `{ inProgress, url }` | Start OAuth PKCE login flow |
| `GET` | `/api/claude/login-status` | — | `{ inProgress, url, error, authenticated }` | Poll login progress |
| `POST` | `/api/claude/login-code` | `{ code }` | `{ success }` or `{ error }` | Submit OAuth authorization code |
| `POST` | `/api/claude/login-cancel` | — | `{ success }` | Cancel active login flow |

---

## Console (PTY Sessions)

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `POST` | `/api/console/create` | `{ cwd?, resume? }` | `{ sessionId, cwd, name }` | Create new Claude CLI PTY session (max 5) |
| `GET` | `/api/console/sessions` | — | `{ sessions: [...] }` | List active sessions |
| `GET` | `/api/console/has-conversations` | `?cwd=<path>` | `{ hasConversations }` | Check if dir has resumable conversations |
| `POST` | `/api/console/rename` | `{ sessionId, name }` | `{ success }` or 404 | Rename a session |
| `POST` | `/api/console/resize` | `{ sessionId, cols, rows }` | `{ success }` | Resize PTY terminal |
| `POST` | `/api/console/destroy` | `{ sessionId }` | `{ success }` | Kill and remove session |
| `POST` | `/api/console/create-shell` | `{ cwd? }` | `{ sessionId, cwd, name }` | Create shell session (bash, no Claude OAuth required). Shares the max 5 session limit with Claude sessions. |

---

## Dashboard

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/dashboard` | — | `{ resources, claude }` | Container resources + Claude usage |

**`resources` object:**
```json
{
  "cpu": { "cores": 4, "usage": 12.5 },
  "memory": { "used": 524288000, "limit": 1073741824, "percent": 48.8 },
  "disk": { "used": 2147483648, "total": 10737418240, "percent": 20.0 },
  "uptime": 3600000,
  "sessions": 2,
  "ports": 2
}
```

**`claude` object:**
```json
{
  "available": true,
  "fiveHour": { "utilization": 45, "percent": 45, "resetsAt": "2025-01-01T12:00:00Z" },
  "sevenDay": { "utilization": 20, "percent": 20, "resetsAt": "2025-01-07T00:00:00Z" }
}
```

---

## Permissions

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/permissions` | — | `{ Read, Edit, Write, Bash, WebFetch, WebSearch }` | Get current permission toggles (all boolean) |
| `POST` | `/api/permissions` | `{ [name]: boolean }` | Updated permissions object | Update one or more permissions |

**Behavior:**
- All default to `true` if not yet configured
- Enabled permissions are synced to `~/.claude/settings.json` `permissions.allow` array
- Changes take effect on the **next** Claude session created (existing sessions are unaffected)

---

## Files (Workspace)

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `GET` | `/api/files` | `?path=<relative>` | `{ success, path, items[] }` | List workspace directory contents |
| `GET` | `/api/files/read` | `?path=<relative>` | `{ success, content, size }` | Read file content (max 100KB) |
| `PUT` | `/api/files/write` | `{ path, content }` | `{ success }` | Write file content (max 500KB, creates parent dirs) |
| `POST` | `/api/files/mkdir` | `{ name }` | `{ success, name, path }` | Create directory in workspace root |
| `DELETE` | `/api/files/delete` | `{ path }` | `{ success }` | Delete file or empty directory |
| `POST` | `/api/files/rename` | `{ oldPath, newPath }` | `{ success }` | Rename/move file or directory |

**`items[]` format:** `{ name, isDirectory, size, modified }`

**Path traversal protection:** All paths resolved and validated against `WORKSPACE` prefix.

---

## Codeck Agent Data

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `GET` | `/api/codeck/files` | `?path=<relative>` | `{ success, path, items[] }` | List `/workspace/.codeck/` directory contents |
| `GET` | `/api/codeck/files/read` | `?path=<relative>` | `{ success, content, size }` | Read agent data file (max 100KB) |
| `PUT` | `/api/codeck/files/write` | `{ path, content }` | `{ success }` | Write to existing agent data file |

**Restrictions:** Cannot create new files (only edit existing). Path traversal protection validates all paths stay within `/workspace/.codeck/`.

---

## Git

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `POST` | `/api/git/clone` | `{ url, token?, useSSH? }` | `CloneResult` | Clone a repository into workspace |

---

## GitHub

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `POST` | `/api/github/login` | — | `{ started, code?, url? }` | Start GitHub device code flow via `gh` CLI |
| `GET` | `/api/github/login-status` | — | `{ inProgress, code, url, success, authenticated }` | Poll GitHub login progress |

**Rate Limiting:**
- GitHub device code creation is limited to 50 codes per hour per application
- Frontend polling of `/api/github/login-status` makes no GitHub API calls (local state only)
- Rate limit errors from `gh auth login` are logged server-side but not currently parsed
- If rate limited, wait 1 hour before retrying authentication

---

## SSH

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/ssh/status` | — | `{ hasKey }` | Check if SSH key exists |
| `POST` | `/api/ssh/generate` | `{ force? }` | `{ success, exists? }` | Generate ed25519 SSH key pair. If `force` is `false` (default) and key exists, returns `{ success: true, exists: true }` without generating. If `force` is `true`, deletes existing key and generates new one, returning `{ success: true, exists: false }`. |
| `GET` | `/api/ssh/public-key` | — | `{ success, publicKey }` | Get SSH public key content |
| `GET` | `/api/ssh/test` | — | `{ success, authenticated }` | Test SSH connection to GitHub |
| `DELETE` | `/api/ssh/key` | — | `{ success }` | Delete SSH key pair |

---

## Projects

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `POST` | `/api/projects/create` | `{ name }` | `{ success, path, name }` | Create empty project directory |
| `POST` | `/api/projects/clone` | `{ url, name?, branch? }` | `{ success, path, name, output }` | Clone git repo with optional branch. **Security:** URL validated via `isValidGitUrl()` (SSRF/Clone2Leak defense), branch name validated against `/^[\w\-.\/]+$/` (flag injection defense) |

---

## System

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/system/network-info` | — | `{ mode, mappedPorts, containerId }` | Network mode and exposed port info |
| `POST` | `/api/system/add-port` | `{ port }` | `{ success, restarting?, alreadyMapped?, requiresRestart?, instructions? }` | Expose a port to the host (auto-restarts container in bridge mode) |
| `POST` | `/api/system/remove-port` | `{ port }` | `{ success, restarting?, notMapped?, requiresRestart?, instructions? }` | Remove a port mapping (mirror of add-port, auto-restarts in bridge mode) |
| `POST` | `/api/system/update-agent` | — | `{ success, version, binaryPath }` | Safely update Claude CLI and re-resolve binary path |
| `GET` | `/api/ports` | — | `Port[]` | List active port mappings (protected, moved behind auth per IMPL-14) |

**`network-info` response:**
```json
{
  "mode": "bridge",
  "mappedPorts": [80],
  "containerId": "a1b2c3d4e5f6"
}
```

**`add-port` responses:**
- `{ "success": true, "alreadyMapped": true }` — port already exposed
- `{ "success": true }` — host mode, all ports accessible
- `{ "success": true, "restarting": true }` — override written, container restarting (sessions auto-restore)
- `{ "success": false, "requiresRestart": true, "instructions": "..." }` — auto-restart unavailable, manual steps needed

**`remove-port` responses:**
- `{ "success": true, "restarting": true, "remainingPorts": [...] }` — override rewritten, container restarting
- `{ "success": true, "notMapped": true }` — port was not mapped
- `{ "success": true, "message": "..." }` — host mode, nothing to remove
- `{ "success": false, "requiresRestart": true, "instructions": "..." }` — auto-restart unavailable

**`ports` response:** `[{ "port": 3000, "exposed": true }, { "port": 5173, "exposed": true }]`

---

## Presets

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/presets` | — | `PresetManifest[]` | List available presets |
| `GET` | `/api/presets/status` | — | `{ configured, presetId, presetName, ... }` | Current preset status |
| `POST` | `/api/presets/apply` | `{ presetId }` | `{ success, presetId }` | Apply a preset configuration |
| `POST` | `/api/presets/reset` | — | `{ success, presetId }` | Force re-apply current preset (overwrites data files) |

---

## Memory

Full CRUD memory system with durable memory, daily journals, ADRs, path-scoped memory, session transcripts, and FTS5 search. All data stored in `/workspace/.codeck/memory/` (agent data) and `/workspace/.codeck/sessions/`, `/workspace/.codeck/index/`, `/workspace/.codeck/state/` (system data).

### Legacy (backward-compat)

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `GET` | `/api/memory/summary` | — | `{ exists, content }` | Read MEMORY.md (falls back to summary.md) |
| `GET` | `/api/memory/decisions` | — | `{ exists, content }` | Read legacy decisions.md (deprecated) |
| `GET` | `/api/memory/journal` | `?date=YYYY-MM-DD` | `{ exists, date, content }` | Backward-compat: delegates to `/daily` |
| `GET` | `/api/memory/journal/list` | — | `{ journals: [{date, size}] }` | Backward-compat: delegates to `/daily/list` |
| `POST` | `/api/memory/journal` | `{ entry, project?, tags? }` | `{ success, date }` | Backward-compat: delegates to POST `/daily` |

### Status

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `GET` | `/api/memory/status` | — | `{ exists, counts, lastFlush, flushState }` | Memory system status overview |
| `GET` | `/api/memory/files` | — | `{ files: Array<{type, path, size, modified}> }` | List all memory files |

### Durable Memory (MEMORY.md)

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `GET` | `/api/memory/durable` | `?pathId=<hash>` | `{ exists, content }` | Read durable memory (global or path-scoped) |
| `PUT` | `/api/memory/durable` | `{ content, pathId? }` | `{ success }` | Overwrite durable memory |
| `POST` | `/api/memory/durable/append` | `{ section, entry, pathId? }` | `{ success }` | Append entry to a section |

### Daily (formerly Journal)

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `GET` | `/api/memory/daily` | `?date=YYYY-MM-DD&pathId=<hash>` | `{ exists, date, content }` | Read daily entry (default: today, global or path-scoped) |
| `GET` | `/api/memory/daily/list` | `?pathId=<hash>` | `{ entries: [{date, size}] }` | List daily files, newest first (global or path-scoped) |
| `POST` | `/api/memory/daily` | `{ entry, pathId?, tags? }` | `{ success, date }` | Append to today's daily entry |

### Decisions (ADR)

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `POST` | `/api/memory/decisions/create` | `{ title, context, decision, consequences, pathId? }` | `{ success, filename }` | Create new ADR (filename: `ADR-YYYYMMDD-<slug>.md`) |
| `GET` | `/api/memory/decisions/list` | `?pathId=<hash>` | `{ decisions: [{filename, title, date}] }` | List ADRs (global or path-scoped) |
| `GET` | `/api/memory/decisions/:filename` | — | `{ exists, content, filename }` | Read specific ADR by filename (not numeric ID) |

### Paths (Path-scoped Memory)

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `GET` | `/api/memory/paths` | — | `{ paths: [{pathId, canonicalPath, name, createdAt}] }` | List all registered paths |
| `GET` | `/api/memory/paths/:pathId` | — | `{ pathId, canonicalPath, name, createdAt, content }` | Get path metadata + memory content |
| `PUT` | `/api/memory/paths/:pathId` | `{ content }` | `{ success }` | Update path-scoped MEMORY.md |
| `POST` | `/api/memory/paths/resolve` | `{ canonicalPath }` | `{ pathId, mapping }` | Resolve absolute path to pathId (creates if new) |
| `DELETE` | `/api/memory/paths/:pathId` | — | `{ success }` | **PLANNED** — Delete path scope and all files (not yet implemented, see AUDIT-76) |
| `POST` | `/api/memory/paths/audit` | `{ fix? }` | `{ orphanedMappings, orphanedDirectories, fixed }` | **PLANNED** — Audit orphaned data (not yet implemented, see AUDIT-76) |

### Promote

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `POST` | `/api/memory/promote` | `PromoteRequest` | `{ success }` | Promote content from daily/session to durable or ADR |

**PromoteRequest body:**
```typescript
{
  content: string;              // Content to promote
  sourceRef?: string;           // Source reference (session ID, date, etc.)
  targetScope?: 'global' | 'path'; // Scope for the promotion
  pathId?: string;              // 12-char hex pathId, required if targetScope='path'
  target: 'durable' | 'adr';   // Promote to MEMORY.md or create ADR
  section?: string;             // Section name for durable target
  tags?: string[];              // Tags for the promoted content
  // ADR-specific fields (required when target='adr'):
  title?: string;
  context?: string;
  decision?: string;
  consequences?: string;
}
```

### Flush

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `POST` | `/api/memory/flush` | `{ content, scope?, project?, tags? }` | `{ success, date }` | Manual context flush to daily (rate-limited: 1 req/30s per scope) |
| `GET` | `/api/memory/flush/state` | — | `{ lastFlush, canFlush, cooldownRemaining }` | Get flush rate-limit state |

### Sessions

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `GET` | `/api/memory/sessions` | — | `{ sessions: [{id, size, createdAt}] }` | List session transcripts |
| `GET` | `/api/memory/sessions/:id` | — | `{ exists, lines: string[] }` | Read session transcript (JSONL) |
| `GET` | `/api/memory/sessions/:id/summary` | — | `{ id, cwd, startTs, endTs, duration, lines }` | Session metadata |

### Search (requires SQLite/FTS5 — Docker only)

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `GET` | `/api/memory/search` | `?q=&scope=&limit=&pathId=&project=&dateFrom=&dateTo=&mode=` | `{ results: SearchResult[], available, mode }` | Search. `mode=hybrid` uses BM25+vector (auto if vec available), `mode=bm25` forces BM25 only. Accessible from localhost without auth. |
| `GET` | `/api/memory/search/stats` | — | `{ available, fileCount, chunkCount, vecCount, vecAvailable, typeCounts }` | Index statistics |
| `POST` | `/api/memory/search/reindex` | — | `{ success, stats }` | Trigger full re-index (may take 5-10s for large repos, runs FTS5 optimize). Returns `409` if reindex already in progress. |
| `GET` | `/api/memory/stats` | — | `{ totalSizeKB, fileCount, oldestDaily, newestDaily, sessionCount, ... }` | Detailed memory stats |

### Context

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `GET` | `/api/memory/context` | `?pathId=<hash>` | `{ context }` | Assembled context (MEMORY.md + today's daily, global or path-scoped) |

---

## Proactive Agents

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `POST` | `/api/agents/lint` | `{ objective }` | `{ warnings: ObjectiveLintWarning[] }` | Lint objective for suspicious Docker patterns |
| `POST` | `/api/agents` | `{ name, objective, schedule, cwd?, model?, timeoutMs?, maxRetries? }` | `AgentDetail & { lintWarnings? }` | Create agent (`schedule` is a cron expression in **UTC**). Returns `lintWarnings` if suspicious patterns detected. |
| `GET` | `/api/agents` | — | `{ agents: AgentSummary[] }` | List all agents |
| `GET` | `/api/agents/:id` | — | `AgentDetail` | Agent detail |
| `PUT` | `/api/agents/:id` | Partial `AgentConfig` | `AgentDetail & { lintWarnings? }` | Update config. Returns `lintWarnings` if objective contains suspicious patterns. |
| `POST` | `/api/agents/:id/pause` | — | `AgentDetail` | Pause (stop cron) |
| `POST` | `/api/agents/:id/resume` | — | `AgentDetail` | Resume (reset failures) |
| `POST` | `/api/agents/:id/execute` | — | `{ executionId }` | Manual trigger |
| `DELETE` | `/api/agents/:id` | — | `{ success }` | Delete agent + files |
| `GET` | `/api/agents/:id/logs` | — | `text/plain` | Latest execution log |
| `GET` | `/api/agents/:id/executions` | `?limit=20` | `{ executions: ExecutionResult[] }` | Execution history |
| `GET` | `/api/agents/:id/output` | `?sanitize=true` | `text/plain` | Live output buffer from current execution. `?sanitize=true` applies secret sanitization. |

---

## Workspace

| Method | Endpoint | Query | Response | Description |
|--------|----------|-------|----------|-------------|
| `GET` | `/api/workspace/export` | `?token=<auth>` | Binary `.tar.gz` | Download workspace as archive (includes `.codeck/` agent data) |

**Note:** Uses `?token=` query param instead of header because browser `<a>` downloads cannot set headers.

**Security Note (Symlinks):** The export follows symlinks by default (GNU `tar` behavior). If `/workspace` contains symlinks pointing to sensitive files (e.g., `evil-project/leak → /workspace/.codeck/auth.json`), the archive will include the target file's contents under the symlink name, potentially bypassing the exclusion list (`--exclude=.codeck/auth.json`). This is a known gap tracked in KNOWN-ISSUES.md. Planned fix: add `--dereference` flag or pre-scan for symlinks and reject export. Users should inspect exported archives before sharing.

---

## Internal Endpoints (Runtime Only)

These endpoints are not exposed through the daemon proxy. They are used for inter-service communication.

| Method | Endpoint | Response | Description |
|--------|----------|----------|-------------|
| `GET` | `/internal/status` | `{ status: "ok", uptime: <seconds> }` | Runtime health check. Used by daemon's `checkRuntime()`. Registered before auth middleware. |

In gateway mode, the runtime also accepts WebSocket connections on a dedicated port (`CODECK_WS_PORT`, default 7778) at `/internal/pty/:id` for per-session PTY streams.

---

## WebSocket

**Connection:** `ws[s]://host?token=<auth_token>`

In gateway mode, the daemon validates the token on upgrade, then proxies the raw TCP connection to the runtime's WS port. The protocol is identical from the client's perspective.

### Client → Server Messages

```json
{ "type": "console:attach", "sessionId": "uuid" }
{ "type": "console:input", "sessionId": "uuid", "data": "keystrokes" }
{ "type": "console:resize", "sessionId": "uuid", "cols": 120, "rows": 30 }
```

### Server → Client Messages

```json
{ "type": "status", "data": { "claude": {...}, "git": {...}, "preset": {...}, "sessions": [...] } }
{ "type": "log", "data": { "type": "info", "message": "...", "timestamp": 123 } }
{ "type": "logs", "data": [ ...LogEntry[] ] }
{ "type": "console:output", "sessionId": "uuid", "data": "terminal output" }
{ "type": "console:exit", "sessionId": "uuid", "exitCode": 0 }
{ "type": "console:error", "sessionId": "uuid", "error": "Session not found" }
{ "type": "ports", "data": [{"port": 3000, "exposed": true}, {"port": 5173, "exposed": true}] }
{ "type": "sessions:restored", "data": [{"id": "uuid", "type": "agent", "cwd": "/workspace/proj", "name": "proj"}] }
{ "type": "heartbeat", "ts": 1707753600000 }
{ "type": "agent:update", "data": { "id": "...", "name": "...", "status": "active", ... } }
{ "type": "agent:output", "data": { "agentId": "...", "text": "streaming output" } }
{ "type": "agent:execution:start", "data": { "agentId": "...", "executionId": "..." } }
{ "type": "agent:execution:complete", "data": { "agentId": "...", "executionId": "...", "result": "success" } }
```

**Note:** The `heartbeat` message is sent every 25s for client-side stale connection detection. Clients should use it to reset their "last message received" timestamp — if no message (of any type) arrives within 45s, the connection is considered stale and should be closed/reconnected.
