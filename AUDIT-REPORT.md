# Codeck Full Product Audit — March 2026

**20 parallel sub-agents, 100% codebase coverage**

---

## Executive Summary

Codeck is technically ambitious and architecturally sound for a solo-developer project. The memory system, proactive agents, and pre-configured tooling are genuine differentiators. However, 14 CRITICAL/HIGH issues must be resolved before any public launch, and the product needs a chat interface and onboarding flow to reach beyond power users.

**Verdict: 6-8 weeks of focused work to production-ready.**

---

## Findings by Severity

### CRITICAL (fix immediately — security/stability)

| # | Area | Issue | File |
|---|------|-------|------|
| C1 | Security | **No `unhandledRejection` handler** — async route errors crash the process in Node 22 | `server.ts` |
| C2 | Security | **Subdomain preview proxy has no auth** — SSRF to any internal port via crafted Host header | `preview-proxy.ts:240` |
| C3 | Security | **Internal PTY WebSocket has no auth** — full terminal access if port is reachable | `internal-pty.ts:7` |
| C4 | Integrations | **Saving a token does NOT create the MCP server** — UI shows "Connected" but the server is never configured | `IntegrationsSection.tsx:344` |
| C5 | Integrations | **`syncEnvToMcpServers()` only updates existing keys** — never adds missing env keys or creates servers | `codeck.routes.ts:30` |
| C6 | Memory | **No SQLite backup/recovery** — corruption = full index loss | `memory-indexer.ts` |
| C7 | Memory | **3 consolidation scripts missing from preset template** — new installs: steps 2-4 silently fail | `preset manifest` |
| C8 | MCP | **GitHub MCP has empty GITHUB_TOKEN** despite gh auth configured | `.claude.json` |

### HIGH (fix before launch)

| # | Area | Issue | File |
|---|------|-------|------|
| H1 | Architecture | **Express 4 async handlers not wrapped** — only `memory.routes.ts` uses `asyncHandler`. All other async routes can crash on rejection | Multiple route files |
| H2 | Security | **CSP in report-only mode** — XSS not blocked | `server.ts:240` |
| H3 | Security | **WebSocket origin check too broad** — `includes("localhost")` matches `evil-localhost.com` | `websocket.ts:627` |
| H4 | Security | **install.sh binds to 0.0.0.0** — exposed to internet before password is set | `install.sh:161` |
| H5 | Terminal | **Double PTY onExit handler** — console.ts + websocket.ts both call `destroySession` | `console.ts:419`, `websocket.ts:455` |
| H6 | Terminal | **Transcript capture stops when WS attaches** — most session output lost from `.jsonl` | `console.ts:398` |
| H7 | Chat | **No markdown rendering** — responses show raw `#`, `**`, `` ``` `` | `ChatSection.tsx` |
| H8 | Chat | **No concurrency limit on chat processes** — unlimited `claude -p` spawns | `chat.routes.ts` |
| H9 | Performance | **`updateAgentBinary()` blocks event loop 5-30s** — `execFileSync` in `setTimeout(0)` | `server.ts:713` |
| H10 | Integrations | **Vercel env key mismatch** — UI saves `VERCEL_API_KEY`, MCP expects `VERCEL_TOKEN` | `IntegrationsSection.tsx:89` |
| H11 | Integrations | **Shell/flow/proactive-agent sessions don't get user env vars** from `.env.encrypted` | `console.ts:462`, `flow-runner.ts:232` |
| H12 | Files | **No blocklist for sensitive files** — `auth.json`, `.env`, `sessions.json` readable via API | `files.routes.ts` |
| H13 | Memory | **`appendToDaily` uses non-atomic write** — crash mid-write corrupts daily log | `memory.ts:366` |
| H14 | Architecture | **`console.ts` god object** — 1066 lines, 25+ exports, needs decomposition | `console.ts` |

### MEDIUM (fix for v1.0)

| # | Area | Issue |
|---|------|-------|
| M1 | Security | CSRF relies on Sec-Fetch-Site only (absent in older browsers) |
| M2 | Security | Static files served before auth (SPA bundle leaked) |
| M3 | Security | Docker container runs as root |
| M4 | Docker | Default memory limit is 0 (unlimited) |
| M5 | Docker | `build-essential` ships in production (~200MB) |
| M6 | Chat | No image/multimodal support |
| M7 | Chat | Naive context management (11-message sliding window, no token counting) |
| M8 | Frontend | 6 components over 800 lines need decomposition |
| M9 | Frontend | 55+ `any` types (worst: `ws.ts` message handler) |
| M10 | Frontend | No code splitting (`@xyflow/react` in main bundle) |
| M11 | Frontend | Color contrast fails WCAG AA |
| M12 | Frontend | Single error boundary for entire app |
| M13 | UX | No onboarding — welcome card disabled, no guided tour |
| M14 | UX | 8+ nav items with confusing names (Orchestrator vs Automated Agents vs Agent Config) |
| M15 | UX | Preview promises auto-detect but doesn't implement it |
| M16 | API | 39% of endpoints undocumented (60 of 155) |
| M17 | API | Error response format inconsistent (`{ error }` vs `{ success: false, error }`) |
| M18 | Orchestrator | No parallel agent execution |
| M19 | Orchestrator | No error recovery (1 agent fails = entire flow fails) |
| M20 | Docs | Zero documentation for Chat, Flows, Preview subsystems |
| M21 | Git | Logout doesn't reset in-memory state |
| M22 | Git | Two duplicate clone endpoints with inconsistent behavior |
| M23 | Workspace import | No path restriction on tar contents |
| M24 | Memory | Recall count hardcoded to 0 (Ebbinghaus decay purely time-based) |
| M25 | Memory | No volume backup strategy |

---

## What Works Well

- **Memory system** — FTS5 + Ebbinghaus decay + HOT/WARM/COLD tiering is genuinely novel
- **Proactive agents** — complete system with retry, timeout, secret sanitization, CWD sandboxing
- **Orchestrator** — real-time streaming, loop detection, visual editor, 4 templates
- **Auth** — scrypt OWASP params, timing-safe comparison, auto-migration from SHA-256
- **Path traversal defense** — `safePath()` + symlink resolution everywhere
- **WebSocket** — watermark backpressure, rate limiting, keepalive, proper cleanup
- **Docker security** — `cap_drop: ALL`, `no-new-privileges`, resource limits, pids limit
- **Installer** — rollback-safe, health check, firewall auto-config
- **Preset system** — 200+ files, additive hook merging, data protection on updates

---

## Top 10 Launch Priorities

1. **Fix `unhandledRejection` + async handler wrapping** (C1, H1) — 1 day
2. **Fix integration flow** (C4, C5, H10, H11) — create MCP server on connect — 2-3 days
3. **Add auth to preview proxy + internal PTY** (C2, C3) — 1 day
4. **Fix install.sh bind to 127.0.0.1** (H4) — 1 line change
5. **Markdown rendering in Chat** (H7) — 2-3 days
6. **First-run onboarding flow** (M13) — 3-5 days
7. **CSP to enforcing mode** (H2) — 1 day with testing
8. **Document Chat/Flows/Preview APIs** (M16, M20) — 2-3 days
9. **Add sensitive file blocklist** (H12) — 1 day
10. **SQLite backup mechanism** (C6) — 1-2 days

**Estimated total: ~3 weeks focused work for the critical path.**

---

## Competitive Position

| Strength | Weakness |
|----------|----------|
| Only product with persistent agent memory | Terminal-only excludes 80%+ of potential users |
| Always-on machine with cron agents | No chat interface (planned, not built) |
| $9.99 undercuts all paid alternatives | Brand confusion (Codeck ↔ Codex) |
| Self-hosted = data sovereignty | No team/multi-user support |
| 200+ pre-configured tools/skills | Onboarding gap — users don't discover capabilities |

**The market opportunity is real — no competitor has persistent memory. But the window is closing as Anthropic, Cursor, and others expand.**
