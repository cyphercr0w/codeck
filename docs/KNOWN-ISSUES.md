# Known Issues & Technical Debt — Codeck

Last updated: 2026-02-19.

---

## Technical Debt

### 1. Duplicate clone endpoints

**Files:** `git.routes.ts`, `project.routes.ts`

Both have `POST /clone` with different behavior. `project.routes.ts` lacks timeout, cleanup on failure, and disk space checks.

**Fix:** Consolidate into one endpoint with timeout (5-10 min), cleanup on failure, and optional `depth` param for shallow clones.

### 2. Duplicated code across file browsers

**Files:** `FilesSection.tsx`, `ConfigSection.tsx`

`FileItem` interface and `formatSize()` helper are copy-pasted. Extract to shared `types.ts`/`utils.ts`.

### 3. `git.ts` is a god-module

**File:** `apps/runtime/src/services/git.ts` (500+ lines)

Handles git, GitHub CLI auth, SSH keys, workspace CLAUDE.md, credentials, and repo listing. Split into `git.ts`, `ssh.ts`, `github.ts`, `workspace.ts`.

### 4. CSS duplication

`@keyframes spin` defined in both `global.css` and `app.css`. Spinner classes split across files.

### 5. Unused `pnpm` in base image

`docker/Dockerfile.base` installs `pnpm` globally but project uses `npm`. Unnecessary image weight.

### 6. Synchronous filesystem operations in routes

**Files:** `files.routes.ts`, `codeck.routes.ts`, `memory.routes.ts`

All use sync fs operations (`readdirSync`, `readFileSync`, `writeFileSync`) blocking the event loop.

### 7. `isGhAuthenticated()` not cached

**File:** `src/services/git.ts`

Spawns `gh auth status` subprocess on every `getGitStatus()` call. All other CLI checks are cached.

### 8. GitHub login state never resets

**File:** `src/routes/github.routes.ts`

`ghLoginState.success` stays `true` permanently until process restart.

### 9. IntegrationsSection polling leak

**File:** `src/web/src/components/IntegrationsSection.tsx`

`pollGitHubLogin()` interval not cleaned up on unmount. Causes memory leaks, wasted API calls, and React warnings.

### 10. Port scanner shells out every 5s

**File:** `src/services/ports.ts`

Spawns `ss` process every 5s. Could read `/proc/net/tcp` directly.

### 11. Console session leak on disconnect

**File:** `src/web/websocket.ts`

PTY sessions keep running when WS client disconnects. No auto-cleanup timeout for orphaned sessions.

### 12. Non-atomic writes in auth/session state

**Files:** `src/services/auth.ts`, `src/services/auth-anthropic.ts`

`writeFileSync()` without atomic pattern. Crash during write corrupts `auth.json`, `sessions.json`, or `.credentials.json`. Fix: apply `atomicWriteFileSync()` (already exists in memory.ts).

### 13. Proactive agent log writes block event loop

**File:** `src/services/proactive-agents.ts`

`appendFileSync()` blocks during disk I/O. Negligible on fast disks, problematic on NFS/SMB.

### 14. No backup/restore verification

Workspace export (`GET /api/workspace/export`) creates `.tar.gz` but has no checksum, no restore testing, no schema migration.

---

## Performance

### PTY → WebSocket backpressure

Backpressure via `pty.pause()`/`resume()` is implemented but has no send queue monitoring. Multiple terminals with high-output commands on slow connections could exhaust memory.

### FTS5 optimize slowdown during reindex

`POST /api/memory/search/reindex` merges FTS5 segments, causing 2-3s query latency spikes. Only during manual reindex (rare).

### Embeddings not available — hybrid search falls back to BM25

`@xenova/transformers` requires `sharp` (native module) which fails to install in the current Docker image. Hybrid search degrades gracefully to BM25-only. sqlite-vec extension loads fine — only the embedding provider is missing.

**Fix:** Either precompile `sharp` + `@xenova/transformers` in `docker/Dockerfile.base`, or use the Gemini fallback (`GEMINI_API_KEY` env var). The WASM model is ~300MB on first download.

### MemorySection component is dead code

`src/web/src/components/MemorySection.tsx` is no longer imported or rendered (Memory tab removed from sidebar). The file remains for potential future use or developer debugging. Delete if not needed.

### Auto-summary file path detection is noisy

`session-summarizer.ts` extracts `/workspace/...` paths from PTY output using regex. This captures false positives (e.g., project name fragments, partial matches from prompts). File paths in summaries may include artifacts like `Moonpad#`.

**Fix:** Validate extracted paths with `existsSync()` before including in summary, or match only paths with file extensions.

### Memory context injection targets workspace CLAUDE.md only

`memory-context.ts` injects the `## Recent Memory` section into `/workspace/CLAUDE.md`. If a project has its own `CLAUDE.md` (e.g., `/workspace/myproject/CLAUDE.md`), the context is not injected there. Claude Code reads both, so it works — but project-level injection would be more targeted.

---

## Security Notes

### Docker socket — root-equivalent host access

**Severity:** Critical (multi-tenant), Medium (personal dev)

Docker socket mount grants full host access. Required for port-manager. Use socket proxy for security-sensitive deployments. Agent objectives are linted for suspicious Docker patterns.

### Agent OAuth token exfiltration risk

Agents receive `CLAUDE_CODE_OAUTH_TOKEN` env var. Malicious objectives could exfiltrate it. Only run trusted objectives.

### Agent workspace not isolated to CWD

Agent `cwd` is just the starting directory. Agents can access all of `/workspace`. For sensitive projects, use separate containers.

### localStorage token storage (accepted)

Session tokens in localStorage are accessible to XSS. Acceptable for single-user sandbox. CSP + DOMPurify + input validation provide defense layers.

### WebSocket token in URL (planned fix)

Token in `ws://...?token=` URL visible in DevTools. Migrate to WebSocket subprotocol header.

### mDNS has no authentication

LAN access via `codeck.local` uses mDNS (RFC 6762), which has no authentication. On untrusted LANs, attackers can spoof `codeck.local` to redirect browsers. Always verify the URL before entering credentials.

### Workspace export follows symlinks

`tar` in export follows symlinks without checking. Malicious symlink to `/workspace/.codeck/auth.json` bypasses exclusion list. Fix: add `--dereference` flag or pre-scan for symlinks.

### Preset destination path symlink following

Preset system validates paths via `resolve()` but not `realpath()`. Symlinks can escape intended directory. Fix: use `realpathSync()` in `isAllowedDestPath()`.

### Secret management notes

- Log sanitization covers common patterns (`sk-ant-*`, `ghp_*`, etc.) but not SSH private keys or custom tokens
- JS strings are immutable — secrets stay in heap until GC
- Agent stderr not sanitized (goes to `console.warn`)
- Live agent output (`GET /api/agents/:id/output`) is unsanitized during execution (design trade-off for debugging)
- Git SSRF defense blocks IPv4 private ranges but not IPv6 link-local/ULA
- GNU tar CVE-2025-45582 (path traversal) — system tar 1.34 vulnerable, update to 1.35+ when available

### Container base image CVEs (unfixed in Debian 12)

CVE-2026-0861, CVE-2026-0915, CVE-2025-15281 — glibc vulnerabilities not exploitable via Codeck's attack surface. Monitor [Debian tracker](https://security-tracker.debian.org/tracker/source-package/glibc) quarterly.

---

## Concurrency

### Session state mutation races

**Files:** `console.ts`, `auth.ts`, `permissions.ts`

Multiple concurrent operations (tab attach, login, permission update) can corrupt state. Fix: use `async-mutex` for critical sections.

### Preset application non-atomic

**File:** `src/services/preset.ts`

Multi-step file operations without locking. Concurrent preset application can interleave. Low severity (user-initiated, infrequent).

---

## Accessibility (WCAG 2.1 AA gaps)

Personal dev tool, not public SaaS. Main gaps:

- **Modals** — Missing `role="dialog"`, `aria-modal`, focus trap, Escape handler
- **Semantic HTML** — No `<main>`, `<nav>`, `<header>` landmarks, all `<div>`
- **Focus indicators** — Several elements set `outline: none` without replacement
- **ARIA labels** — Sidebar items, terminal tabs, file browser buttons lack labels
- **Heading hierarchy** — Jumps levels, no `<h1>` in app

---

## Deferred improvements (from security audit, 2026-02-14)

These were identified during a 124-item automated security audit. Implemented 86 items, deferred the following categories:

| Category | Items | Examples |
|----------|-------|---------|
| CI/CD automation | 7 | Renovate, automated CVE scanning, base image updates |
| Operational monitoring | 6 | Disk usage alerts, log rotation, metrics dashboard |
| Architecture changes | 5 | CSP nonce-based (no `unsafe-inline`), HttpOnly cookies, container-per-project |
| Documentation gaps | 5 | ARCHITECTURE.md startup steps, SERVICES.md sync, CONFIGURATION.md updates |
| Feature enhancements | 3 | Agent log indexing for search, input buffering during WS disconnect |
| Runtime testing | 1 | Remove `DAC_OVERRIDE` capability (requires Docker validation) |

None are security-critical. Most are operational polish or would require significant architecture changes.

---

## Gateway Mode (daemon/runtime split)

### Daemon/runtime session mismatch

In gateway mode, the daemon and runtime maintain separate session stores. A user logs in once to the daemon — the runtime trusts the private network. If the runtime's `auth.json` password is changed, the daemon's validation still uses the old cached read. **Workaround:** Restart the daemon after password changes.

### WS proxy reconnection on partial restart

If the runtime restarts while the daemon is running, all proxied WS connections drop. The daemon returns 502 on new WS upgrades until the runtime is back. Clients auto-reconnect, but there's a visible disconnect period. If the daemon restarts, clients must re-authenticate (daemon sessions are lost unless persisted).

### HTTP proxy body re-serialization

The daemon's HTTP proxy re-serializes `req.body` after `express.json()` consumes the stream. This works for all current JSON-only API endpoints. If file upload endpoints are added to the runtime, the proxy will need raw body passthrough.

### Audit log rotation

The daemon's `audit.log` is append-only JSONL with no rotation. On busy systems this file grows indefinitely. **Workaround:** External logrotate or periodic manual truncation.
