# Known Issues & Technical Debt — Codeck

Last updated: 2026-04-02.

---

## Technical Debt

### 1. Duplicate clone endpoints

**Files:** `git.routes.ts`, `project.routes.ts`

Both have `POST /clone` with different behavior. `project.routes.ts` lacks timeout, cleanup on failure, and disk space checks.

**Fix:** Consolidate into one endpoint with timeout (5-10 min), cleanup on failure, and optional `depth` param.

### 2. Duplicated code across file browsers

**Files:** `FilesSection.tsx`, `AgentConfigSection.tsx`

`FileItem` interface and `formatSize()` helper are copy-pasted. Extract to shared `types.ts`/`utils.ts`.

### 3. CSS duplication

`@keyframes spin` defined in both `global.css` and `app.css`. Spinner classes split across files.

### 4. Unused `pnpm` in base image

`docker/Dockerfile.base` installs `pnpm` globally but project uses `npm`. Unnecessary image weight.

### 5. Synchronous filesystem operations in routes

**Files:** `files.routes.ts`, `codeck.routes.ts`, `memory.routes.ts`

All use sync fs operations (`readdirSync`, `readFileSync`, `writeFileSync`) blocking the event loop.

### 6. `isGhAuthenticated()` not cached

**File:** `services/git.ts`

Spawns `gh auth status` subprocess on every `getGitStatus()` call. All other CLI checks are cached.

### 7. GitHub login state never resets

**File:** `github.routes.ts`

`ghLoginState.success` stays `true` permanently until process restart.

### 8. IntegrationsSection polling leak

**File:** `IntegrationsSection.tsx`

`pollGitHubLogin()` interval not cleaned up on unmount. Causes memory leaks and wasted API calls.

### 9. Port scanner shells out every 5s

**File:** `services/ports.ts`

Spawns `ss` process every 5s. Could read `/proc/net/tcp` directly.

### 10. Console session leak on disconnect

**File:** `websocket.ts`

PTY sessions keep running when WS client disconnects. No auto-cleanup timeout for orphaned sessions.

### 11. Non-atomic writes in auth/session state

**Files:** `services/auth.ts`, `services/auth-anthropic.ts`

`writeFileSync()` without atomic pattern. Crash during write corrupts `auth.json`, `sessions.json`, or `.credentials.json`. Fix: apply `atomicWriteFileSync()` (exists in memory.ts).

### 12. Proactive agent log writes block event loop

**File:** `services/proactive-agents.ts`

`appendFileSync()` blocks during disk I/O. Negligible on fast disks, problematic on NFS/SMB.

### 13. No backup/restore verification

Workspace export (`GET /api/workspace/export`) creates `.tar.gz` but has no checksum, no restore testing, no schema migration.

### 14. Command injection risk in auth-anthropic version check

**File:** `services/auth-anthropic.ts`

String interpolation used for agent binary and version flag. Should use `execFileSync(binary, [flag])` with array arguments instead to prevent shell injection.

**Severity:** Critical (RCE if agent config contaminated)

### 15. SQL injection in memory-indexer embedding dimension

**File:** `services/memory-indexer.ts`

Template literal with `${dim}` for `CREATE VIRTUAL TABLE`. Validate `getEmbeddingDim()` is numeric and bounded.

**Severity:** Critical (if dim is attacker-controlled)

### 16. CWD not validated in console create

**File:** `console.routes.ts`

`req.body.cwd` passed directly to `createConsoleSession` without `safePath()` validation. Path traversal possible.

**Severity:** High (path traversal)

### 17. Iterator invalidation in WebSocket cleanup

**File:** `websocket.ts`

Deleting from `sessionActiveClient` Map while iterating it. Collect keys first, then delete.

**Severity:** Medium (stale state)

### 18. Session creation boolean lock race

**File:** `services/console.ts`

Boolean flag `sessionCreationLocked` not reset if exception thrown before `finally`. Use try/finally pattern.

**Severity:** Medium (blocks new sessions permanently)

### 19. ANSI sanitizer missing C1 control codes

**File:** `apps/web/src/ansi-sanitizer.ts`

Does not strip 8-bit C1 control codes (0x80-0x9F). Missing protection against OSC 52 clipboard injection.

**Severity:** Medium (terminal injection)

### 20. Env var values unbounded in codeck routes

**File:** `codeck.routes.ts`

No length limit on env var values — could cause OOM or config bloat.

**Severity:** Medium (DoS)

### 21. Memory search not rate-limited

**File:** `memory.routes.ts`

FTS5 search endpoint has no rate limiting. Expensive queries exploitable for DoS.

**Severity:** Medium

### 22. Frontend file import OOM risk

**File:** `HomeSection.tsx`

FileReader base64 encoding loads entire file into memory. No size validation before read. Large files crash the browser.

**Severity:** Medium (browser DoS)

### 23. SendMessage to completed agent resumes in background silently

**File:** Claude Code native behavior (Agent Teams)

When using `SendMessage` to a completed/idle agent, the system resumes it in background mode automatically. The caller gets no streaming output and only a task-notification when done. This can cause confusion when the user expects foreground interaction.

**Workaround:** Re-launch a new `Agent` in foreground instead of using `SendMessage` to resume a completed agent.

**Severity:** Low (UX confusion, no data loss)

### 24. TeammateWatcher blocks event loop with execFileSync (FIXED)

**File:** `services/teammate-watcher.ts`

`execFileSync` calls for tmux and ps commands ran synchronously every 3 seconds, blocking the Node.js event loop. With multiple active team sessions, this caused WebSocket heartbeat misses, making the terminal appear crashed.

**Fix:** Converted all `execFileSync` calls to async `execFile` with promisify. Added polling guard to prevent overlapping async cycles. Same pattern as `sub-agent-monitor.ts`.

### 25. No resource monitoring during Agent Teams execution (FIXED)

**Files:** `services/resource-watchdog.ts` (new), `services/resources.ts`

When Agent Teams spawned multiple Claude CLI sub-processes, PID exhaustion (Docker limit: 1024), CPU saturation, and memory pressure caused silent crashes with no diagnostic logs.

**Fix:** Added `resource-watchdog.ts` service that monitors PIDs, CPU, and memory every 5 seconds while teams are active. Logs warnings at 78% PID usage, critical alerts at 93% with full process tree dump. Persistent log file at `/workspace/.codeck/logs/watchdog.log`.

---

## Performance

### PTY to WebSocket backpressure

Backpressure via `pty.pause()`/`resume()` is implemented but has no send queue monitoring. Multiple terminals with high-output commands on slow connections could exhaust memory.

### Resource watchdog overhead

`resource-watchdog.ts` polls cgroup files every 5s while teams are active. Reads `/sys/fs/cgroup/pids.current`, `memory.current`, `cpu.stat` — all kernel virtual files with negligible I/O. No `execFile` unless critical threshold triggers a process tree dump.

### FTS5 optimize slowdown during reindex

`POST /api/memory/search/reindex` merges FTS5 segments, causing 2-3s query latency spikes. Only during manual reindex (rare).

### Embeddings not available — hybrid search falls back to BM25

`@xenova/transformers` requires `sharp` (native module) which fails to install in the current Docker image. Hybrid search degrades to BM25-only. sqlite-vec extension loads fine.

**Fix:** Precompile `sharp` + `@xenova/transformers` in `docker/Dockerfile.base`, or use the Gemini fallback (`GEMINI_API_KEY` env var).

### Auto-summary file path detection is noisy

`session-summarizer.ts` extracts `/workspace/...` paths from PTY output via regex, capturing false positives.

**Fix:** Validate with `existsSync()` before including in summary.

### Memory context injection targets workspace CLAUDE.md only

`memory-context.ts` injects into `/workspace/CLAUDE.md`. Project-level CLAUDE.md files don't get injected context. Works because Claude Code reads both, but project-level injection would be more targeted.

---

## Security Notes

### Docker socket — root-equivalent host access

**Severity:** Critical (multi-tenant), Medium (personal dev)

Docker socket not mounted by default. If mounted for port auto-exposure, grants full host access. Agent objectives are linted for suspicious Docker patterns.

### Agent OAuth token exfiltration risk

Agents receive `CLAUDE_CODE_OAUTH_TOKEN` env var. Malicious objectives could exfiltrate it. Only run trusted objectives.

### Agent workspace not isolated to CWD

Agent `cwd` is just the starting directory. Agents can access all of `/workspace`. For sensitive projects, use separate containers.

### localStorage token storage (accepted)

Session tokens in localStorage are accessible to XSS. Acceptable for single-user sandbox. CSP + DOMPurify + input validation provide defense layers.

### WebSocket token in URL (partially fixed)

Primary auth now via WebSocket subprotocol header. Query param `?token=` fallback exists for backward compat. Ticket-based auth also implemented.

### Workspace export follows symlinks

`tar` in export follows symlinks without checking. Malicious symlink to `/workspace/.codeck/auth.json` bypasses exclusion list. Fix: add `--dereference` or pre-scan for symlinks.

### Preset destination path symlink following

Preset system validates paths via `resolve()` but not `realpath()`. Symlinks can escape intended directory. Fix: use `realpathSync()`.

### Secret management notes

- Log sanitization covers common patterns but not SSH private keys or custom tokens
- JS strings are immutable — secrets stay in heap until GC
- Agent stderr not sanitized (goes to `console.warn`)
- Live agent output unsanitized during execution (debugging trade-off)
- Git SSRF defense blocks IPv4 private ranges but not IPv6 link-local/ULA
- GNU tar CVE-2025-45582 (path traversal) — update to 1.35+ when available

### Container base image CVEs (unfixed in Debian 12)

CVE-2026-0861, CVE-2026-0915, CVE-2025-15281 — glibc vulnerabilities not exploitable via Codeck's attack surface. Monitor [Debian tracker](https://security-tracker.debian.org/tracker/source-package/glibc) quarterly.

---

## Concurrency

### Session state mutation races

**Files:** `console.ts`, `auth.ts`, `permissions.ts`

Multiple concurrent operations can corrupt state. Fix: use `async-mutex` for critical sections.

### Preset application non-atomic

**File:** `services/preset.ts`

Multi-step file operations without locking. Concurrent preset application can interleave. Low severity (user-initiated, infrequent).

---

## Test Coverage Gaps

### Coverage enforcement disabled

`vitest.config.ts` has all coverage thresholds set to 0. Per project rules, 80% is non-negotiable. Enable before beta.

### 12 routes with no tests

cli-auth, codeck, dashboard, git, github, hooks, mcp, preset, project, skills, ssh, workspace — all completely untested.

### 20+ services with no tests

All memory services (7 files), all agent services, git operations, preset system, port management, session tracking, embeddings — no tests exist.

### Frontend: 0% test coverage

No component tests, no snapshot tests, no E2E tests for the frontend.

### Flaky timing test

`auth.test.ts` timing-attack test fails on slow containers (scrypt dominates timing). Relax threshold or use statistical methods.

---

## Accessibility (WCAG 2.1 AA gaps)

Personal dev tool, not public SaaS. Main gaps:

- **Modals** — LoginModal focus not returned to trigger on close
- **Tab rename** — `ClaudeSection.tsx` span with onDblClick not keyboard-accessible
- **Spinners** — SubagentPanel spinners lack `aria-hidden="true"`
- **HTML lang** — No `lang="en"` attribute on root HTML element
- **Terminal font** — Font size not user-configurable
- **Focus indicators** — Several elements set `outline: none` without replacement
- **Heading hierarchy** — Jumps levels, no `<h1>` in app

---

## Deferred improvements

These were identified during a 124-item automated security audit. Implemented 86 items, deferred the following:

| Category | Items | Examples |
|----------|-------|---------|
| CI/CD automation | 7 | Renovate, automated CVE scanning, base image updates |
| Operational monitoring | 6 | Disk usage alerts, log rotation, metrics dashboard |
| Architecture changes | 5 | CSP nonce-based (no `unsafe-inline`), HttpOnly cookies, container-per-project |
| Documentation gaps | 5 | Startup steps, service sync, config updates |
| Feature enhancements | 3 | Agent log indexing for search, input buffering during WS disconnect |
| Runtime testing | 1 | Remove `DAC_OVERRIDE` capability (requires Docker validation) |

None are security-critical. Most are operational polish or would require significant architecture changes.
