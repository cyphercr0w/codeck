# API Reference — Codeck Sandbox

All endpoints are served by a single Express server on port 80 inside the container. All protected endpoints require `Authorization: Bearer <token>` header (or `?token=<token>` for download links).

---

## Authentication (Public)

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/auth/status` | — | `{ configured: boolean }` | Check if password is set up |
| `POST` | `/api/auth/setup` | `{ password }` | `{ success, token }` | Set initial password (min 8, max 256 chars, one-time) |
| `POST` | `/api/auth/login` | `{ password }` | `{ success, token }` or `{ error }` | Login with password. Locked out for 15 min after 5 failures. |

## Authentication (Protected)

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `POST` | `/api/auth/logout` | — | `{ success }` | Invalidate current session token |
| `POST` | `/api/auth/change-password` | `{ currentPassword, newPassword }` | `{ success, token }` or `{ error }` | Change password. Invalidates all sessions. |
| `GET` | `/api/auth/sessions` | — | `SessionInfo[]` | List active sessions (sorted by lastSeen DESC) |
| `DELETE` | `/api/auth/sessions/:id` | — | `{ success }` or 404 | Revoke a specific session |
| `GET` | `/api/auth/log` | — | `AuthLogEntry[]` | Auth event history |

---

## Status (Protected)

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/status` | — | `{ claude, git, preset, sessions, account, workspace, agent }` | Combined system status |
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
| `POST` | `/api/console/create-shell` | `{ cwd? }` | `{ sessionId, cwd, name }` | Create shell session (bash, no OAuth required). Shares max 5 limit. |

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

### Basic Tool Permissions

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/permissions` | — | `{ Read, Edit, Write, Bash, WebFetch, WebSearch }` | Get current permission toggles (all boolean) |
| `POST` | `/api/permissions` | `{ [name]: boolean }` | Updated permissions object | Update one or more permissions |

### MCP Server Permissions

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/permissions/mcp` | — | `{ servers: McpPermissions }` | Get MCP server permission state |
| `POST` | `/api/permissions/mcp` | `{ name, allowed }` | `{ servers: McpPermissions }` | Set MCP server allowed/denied |

### Deny Rules

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/permissions/deny` | — | `{ rules: DenyRule[] }` | Get deny rules (read-only) |

### Combined View

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/permissions/all` | — | `{ basic, mcp, deny }` | Full permission state |

**Behavior:**
- All defaults to `true` if not configured
- Permissions synced to `~/.claude/settings.json` `permissions.allow` array
- Changes take effect on the **next** Claude session (existing sessions unaffected)

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

**Path traversal protection:** All paths resolved and validated against `WORKSPACE` prefix.

---

## Codeck Agent Data

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `GET` | `/api/codeck/files` | `?path=<relative>` | `{ success, path, items[] }` | List `/workspace/.codeck/` directory contents |
| `GET` | `/api/codeck/files/read` | `?path=<relative>` | `{ success, content, size }` | Read agent data file (max 100KB) |
| `PUT` | `/api/codeck/files/write` | `{ path, content }` | `{ success }` | Write to agent data file |

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

---

## CLI Auth (Third-Party Services)

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/cli-auth/supported` | — | `{ services: string[] }` | List supported CLI auth services |
| `POST` | `/api/cli-auth/:service/login` | — | `CLIAuthState` | Start device flow for service |
| `GET` | `/api/cli-auth/:service/status` | — | `CLIAuthState` | Poll auth status |
| `POST` | `/api/cli-auth/:service/cancel` | — | `{ cancelled }` | Cancel in-progress login |
| `GET` | `/api/cli-auth/:service/authenticated` | — | `{ authenticated, username? }` | Check if CLI is logged in (rate limited: 20s cooldown) |

Currently supported services: `vercel`.

---

## SSH

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/ssh/status` | — | `{ hasKey }` | Check if SSH key exists |
| `POST` | `/api/ssh/generate` | `{ force? }` | `{ success, exists? }` | Generate ed25519 SSH key pair |
| `GET` | `/api/ssh/public-key` | — | `{ success, publicKey }` | Get SSH public key content |
| `GET` | `/api/ssh/test` | — | `{ success, authenticated }` | Test SSH connection to GitHub |
| `DELETE` | `/api/ssh/key` | — | `{ success }` | Delete SSH key pair |

---

## Projects

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `POST` | `/api/projects/create` | `{ name }` | `{ success, path, name }` | Create empty project directory |
| `POST` | `/api/projects/clone` | `{ url, name?, branch? }` | `{ success, path, name, output }` | Clone git repo. URL validated against SSRF/Clone2Leak defense. |

---

## System

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/system/network-info` | — | `{ mode, mappedPorts, containerId }` | Network mode and exposed port info |
| `POST` | `/api/system/add-port` | `{ port }` | `{ success, ... }` | Expose a port to the host (auto-restarts container if possible) |
| `POST` | `/api/system/remove-port` | `{ port }` | `{ success, ... }` | Remove a port mapping |
| `POST` | `/api/system/restart` | — | `{ success, restarting? }` | Restart the container (requires compose info) |
| `POST` | `/api/system/update-agent` | — | `{ success, version, binaryPath }` | Update Claude CLI and re-resolve binary path |
| `GET` | `/api/system/model` | — | `{ model }` | Get current Claude model (default: sonnet) |
| `POST` | `/api/system/model` | `{ model }` | `{ success, model }` | Set Claude model. Valid: sonnet, opus, opus[1m], haiku |

**`add-port` responses:**
- `{ "success": true, "alreadyMapped": true }` — port already exposed
- `{ "success": true, "restarting": true }` — override written, container restarting
- `{ "success": false, "requiresRestart": true, "instructions": "..." }` — manual steps needed

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

Full CRUD memory system with durable memory, daily journals, ADRs, path-scoped memory, session transcripts, and FTS5 search.

### Status

| Method | Endpoint | Response | Description |
|--------|----------|----------|-------------|
| `GET` | `/api/memory/status` | `{ exists, counts, lastFlush, flushState }` | Memory system overview |
| `GET` | `/api/memory/files` | `{ files: Array<{type, path, size, modified}> }` | List all memory files |
| `GET` | `/api/memory/stats` | `{ totalSizeKB, fileCount, ... }` | Detailed memory stats |

### Durable Memory

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `GET` | `/api/memory/durable` | `?pathId=<hash>` | `{ exists, content }` | Read MEMORY.md |
| `PUT` | `/api/memory/durable` | `{ content, pathId? }` | `{ success }` | Overwrite MEMORY.md |
| `POST` | `/api/memory/durable/append` | `{ section, entry, pathId? }` | `{ success }` | Append to section |

### Daily

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `GET` | `/api/memory/daily` | `?date=YYYY-MM-DD&pathId=` | `{ exists, date, content }` | Read daily entry |
| `GET` | `/api/memory/daily/list` | `?pathId=` | `{ entries: [{date, size}] }` | List daily files |
| `POST` | `/api/memory/daily` | `{ entry, pathId?, tags? }` | `{ success, date }` | Append to today |

### Decisions (ADR)

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `POST` | `/api/memory/decisions/create` | `{ title, context, decision, consequences, pathId? }` | `{ success, filename }` | Create ADR |
| `GET` | `/api/memory/decisions/list` | `?pathId=` | `{ decisions: [...] }` | List ADRs |
| `GET` | `/api/memory/decisions/:filename` | — | `{ exists, content, filename }` | Read specific ADR |

### Paths

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `GET` | `/api/memory/paths` | — | `{ paths: [...] }` | List registered paths |
| `GET` | `/api/memory/paths/:pathId` | — | Path metadata + memory content | Get path details |
| `PUT` | `/api/memory/paths/:pathId` | `{ content }` | `{ success }` | Update path-scoped MEMORY.md |
| `POST` | `/api/memory/paths/resolve` | `{ canonicalPath }` | `{ pathId, mapping }` | Resolve path to pathId |

### Search

| Method | Endpoint | Query | Response | Description |
|--------|----------|-------|----------|-------------|
| `GET` | `/api/memory/search` | `?q=&scope=&limit=&pathId=&mode=` | `{ results, available, mode }` | FTS5/hybrid search. Accessible from localhost without auth. |
| `GET` | `/api/memory/search/compact` | `?q=&limit=&scope=&pathId=` | `{ results, total, query }` | Token-efficient compact index (~50 tokens/result). Use for progressive disclosure step 1. |
| `GET` | `/api/memory/search/stats` | — | `{ available, fileCount, chunkCount, ... }` | Index statistics |
| `POST` | `/api/memory/search/reindex` | — | `{ success, stats }` | Trigger full re-index (409 if in progress) |

### Observations (Granular Tool Tracking)

Per-tool-use observation capture inspired by claude-mem. Privacy: `<private>` tags stripped before storage.

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `POST` | `/api/observations/capture` | `{ session_id, tool, type?, title?, files?, concepts?, narrative? }` | `{ id }` | Capture observation (from PostToolUse hook) |
| `GET` | `/api/observations/search` | `?query=&type=&limit=&offset=` | `{ results, total, query }` | Compact FTS5 search (~50 tokens/result) |
| `GET` | `/api/observations/:id` | — | `Observation` | Full observation detail |
| `POST` | `/api/observations/batch` | `{ ids: number[] }` | `{ observations }` | Batch fetch by IDs (max 100) |
| `GET` | `/api/observations/stats` | — | `{ total, byType, available }` | Counts by type |
| `GET` | `/api/observations` | `?type=&limit=&offset=&since=` | `{ observations }` | List recent (compact) |

Types: `feature`, `bugfix`, `discovery`, `decision`, `change`

### Memory Connectors

Sync between memory stores (markdown files, daily logs, SQLite index).

| Method | Endpoint | Response | Description |
|--------|----------|----------|-------------|
| `GET` | `/api/memory/connectors` | `{ connectors: ConnectorConfig[] }` | List connector status |
| `POST` | `/api/memory/connectors/sync` | `{ results: SyncResult[] }` | Sync all enabled connectors |
| `POST` | `/api/memory/connectors/:name/sync` | `SyncResult` | Sync specific connector |

### Context & Flush

| Method | Endpoint | Body/Query | Response | Description |
|--------|----------|------------|----------|-------------|
| `GET` | `/api/memory/context` | `?pathId=` | `{ context }` | Assembled context (MEMORY.md + daily) |
| `POST` | `/api/memory/flush` | `{ content, scope?, tags? }` | `{ success, date }` | Manual flush to daily (1 req/30s rate limit) |
| `GET` | `/api/memory/flush/state` | — | `{ lastFlush, canFlush, cooldownRemaining }` | Flush rate-limit state |

### Promote

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `POST` | `/api/memory/promote` | `PromoteRequest` | `{ success }` | Promote content to durable or ADR |

### Sessions

| Method | Endpoint | Response | Description |
|--------|----------|----------|-------------|
| `GET` | `/api/memory/sessions` | `{ sessions: [{id, size, createdAt}] }` | List transcripts |
| `GET` | `/api/memory/sessions/:id` | `{ exists, lines }` | Read transcript (JSONL) |
| `GET` | `/api/memory/sessions/:id/summary` | `{ id, cwd, startTs, endTs, duration, lines }` | Session metadata |

---

## Proactive Agents

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `POST` | `/api/agents/lint` | `{ objective }` | `{ warnings }` | Lint objective for suspicious patterns |
| `POST` | `/api/agents` | `{ name, objective, schedule, cwd?, model?, timeoutMs? }` | `AgentDetail` | Create agent (cron schedule, UTC) |
| `GET` | `/api/agents` | — | `{ agents: AgentSummary[] }` | List all agents |
| `GET` | `/api/agents/:id` | — | `AgentDetail` | Agent detail |
| `PUT` | `/api/agents/:id` | Partial `AgentConfig` | `AgentDetail` | Update config |
| `POST` | `/api/agents/:id/pause` | — | `AgentDetail` | Pause (stop cron) |
| `POST` | `/api/agents/:id/resume` | — | `AgentDetail` | Resume (reset failures) |
| `POST` | `/api/agents/:id/execute` | — | `{ executionId }` | Manual trigger |
| `DELETE` | `/api/agents/:id` | — | `{ success }` | Delete agent + files |
| `GET` | `/api/agents/:id/logs` | — | `text/plain` | Latest execution log |
| `GET` | `/api/agents/:id/executions` | `?limit=20` | `{ executions }` | Execution history |
| `GET` | `/api/agents/:id/output` | `?sanitize=true` | `text/plain` | Live output buffer |

---

## Workspace

| Method | Endpoint | Query | Response | Description |
|--------|----------|-------|----------|-------------|
| `GET` | `/api/workspace/export` | `?token=<auth>` | Binary `.tar.gz` | Download workspace as archive |

Uses `?token=` because browser downloads can't set headers.

---

## Ports

| Method | Endpoint | Response | Description |
|--------|----------|----------|-------------|
| `GET` | `/api/ports` | `Port[]` | List active port mappings (protected) |

---

## Internal Endpoints

| Method | Endpoint | Response | Description |
|--------|----------|----------|-------------|
| `GET` | `/internal/status` | `{ status: "ok", uptime }` | Health check. Registered before auth middleware. |

---

## WebSocket

**Connection:** `ws[s]://host?token=<auth_token>`

### Client → Server Messages

```json
{ "type": "console:attach", "sessionId": "uuid" }
{ "type": "console:input", "sessionId": "uuid", "data": "keystrokes" }
{ "type": "console:resize", "sessionId": "uuid", "cols": 120, "rows": 30 }
```

### Server → Client Messages

```json
{ "type": "status", "data": { "claude": {}, "git": {}, "preset": {}, "sessions": [] } }
{ "type": "log", "data": { "type": "info", "message": "...", "timestamp": 123 } }
{ "type": "logs", "data": [ ...LogEntry[] ] }
{ "type": "console:output", "sessionId": "uuid", "data": "terminal output" }
{ "type": "console:exit", "sessionId": "uuid", "exitCode": 0 }
{ "type": "console:error", "sessionId": "uuid", "error": "Session not found" }
{ "type": "ports", "data": [{"port": 3000, "exposed": true}] }
{ "type": "sessions:restored", "data": [{"id": "uuid", "type": "agent", "cwd": "/workspace/proj", "name": "proj"}] }
{ "type": "heartbeat", "ts": 1707753600000 }
{ "type": "agent:update", "data": { "id": "...", "name": "...", "status": "active" } }
{ "type": "agent:output", "data": { "agentId": "...", "text": "streaming output" } }
{ "type": "agent:execution:start", "data": { "agentId": "...", "executionId": "..." } }
{ "type": "agent:execution:complete", "data": { "agentId": "...", "executionId": "...", "result": "success" } }
{ "type": "subagent:start", "data": { "agentId": "...", "type": "...", "parentSession": "..." } }
{ "type": "subagent:stop", "data": { "agentId": "...", "duration": 1234 } }
```

**Heartbeat:** Sent every 25s. Client closes/reconnects if no data arrives within 45s.

---

## Chat

Conversational interface using `claude -p` with streaming JSON output. Conversations persisted as JSON files in `/workspace/.codeck/conversations/`.

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `POST` | `/api/chat/message` | `{ message, context?, conversationId?, model? }` | SSE stream | Send message, get streaming response |
| `POST` | `/api/chat/cancel` | `{ chatId?, executionId? }` | `{ success }` | Cancel active stream or team execution |
| `GET` | `/api/chat/conversations` | — | `{ conversations: [...] }` | List all conversations (newest first) |
| `GET` | `/api/chat/conversations/:id` | — | `ChatConversation` | Get conversation with all messages |
| `POST` | `/api/chat/conversations` | `{ name? }` | `{ id, name }` | Create empty conversation |
| `PUT` | `/api/chat/conversations/:id/name` | `{ name }` | `{ id, name }` | Rename conversation |
| `DELETE` | `/api/chat/conversations/:id` | — | `{ success }` | Delete conversation |

---

## Agent Teams (localhost bypass)

Team templates define parallel agent groups powered by Claude Code Agent Teams (experimental). Each agent gets its own tmux pane, bridged to the frontend via `TmuxPtyAdapter` → standard `console:*` WebSocket messages.

### Template CRUD

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `GET` | `/api/teams` | — | `{ templates: TeamTemplate[] }` | List all team templates |
| `GET` | `/api/teams/:id` | — | `TeamTemplate` | Get template by ID |
| `POST` | `/api/teams` | `{ name, description?, agents }` | `TeamTemplate` (201) | Create template. Each agent needs `name`, `role`, `systemPrompt`, optional `allowedTools[]`. |
| `PUT` | `/api/teams/:id` | `{ name?, description?, agents? }` | `TeamTemplate` | Update template |
| `DELETE` | `/api/teams/:id` | — | `{ ok: true }` | Delete template |

### Execution

| Method | Endpoint | Body | Response | Description |
|--------|----------|------|----------|-------------|
| `POST` | `/api/teams/:id/launch` | `{ input?, cwd? }` | `{ executionId, status, leaderSessionId }` (202) | Launch team from template. Creates tmux session, starts Claude with Agent Teams. |
| `POST` | `/api/teams/launch-inline` | `{ agents, name?, input?, cwd? }` | `{ executionId, status, leaderSessionId }` (202) | Launch ad-hoc team without template. |
| `POST` | `/api/teams/executions/:id/stop` | — | `{ ok: true, status }` | Stop running team. Kills tmux session. |
| `GET` | `/api/teams/executions/list` | — | `{ executions: TeamExecution[] }` | List active + recent executions |
| `GET` | `/api/teams/executions/:id` | — | `TeamExecution` | Get execution status |

### WebSocket Events

```jsonc
{ "type": "team:launched", "data": { "executionId": "...", "templateName": "...", "agents": [...], "leaderSessionId": "..." } }
{ "type": "team:agent:detected", "data": { "executionId": "...", "agentId": "...", "name": "...", "role": "...", "sessionId": "...", "tmuxPane": "..." } }
{ "type": "team:agent:shutdown", "data": { "executionId": "...", "agentId": "..." } }
{ "type": "team:stopped", "data": { "executionId": "...", "status": "completed|cancelled|failed" } }
```

Agent terminal output streams via standard `console:output` messages using the agent's `sessionId`.
