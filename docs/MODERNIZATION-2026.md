# Codeck Modernization Roadmap — Q3 2026

**Status:** Proposed (pending approval) · **Created:** 2026-07-15 · **Branch:** `dev`

## Context

Codeck (v0.6.0) is pinned to **Claude Code `2.1.39`** (~March 2026). Upstream is at **`~2.1.210`** (~July 14, 2026) and the whole ecosystem moved: new model generation (Opus 4.8 / Sonnet 5 / Fable 5), Agent Teams re-architected, ~30 hook events, plugin distribution, and the `ecc` upstream re-framed into a v2.0 "Agent Harness OS".

This roadmap sequences the catch-up work so that **nothing breaks when we bump the CLI pin**, then layers on new capabilities.

Model IDs, version facts and sources: see the research summary at the bottom of this doc and the reasoning in the PR that lands each phase.

---

## Status (2026-07-15) — branch `feat/modernization-2026`

| Phase | Status | Notes |
|---|---|---|
| **0 — CLI compat** | ✅ Done | Teams guidance rewritten for implicit teams; `teams-reminder-hook` no longer blocks on removed `team_name`; deprecated `Write(path)` rules dropped; pin bumped `2.1.39 → 2.1.210`. |
| **1 — Models** | ✅ Done | `MODEL_MAP` fixed (stale chat-API IDs → Opus 4.8 / Sonnet 5 / Fable 5); `fable` alias + UI labels; `fallbackModel: sonnet` added. |
| **2 — New features** | ◑ Partial | Added `isolation: 'worktree'` guidance for parallel teammates. Remaining items (`/rewind` UX, new `post-session`/`Setup` hooks, Skills 2.0 `context: fork`) deferred — they need runtime/container validation the user will do. |
| **3 — ecc v2.0 resync** | ✅ Done | **The research overstated the gap.** Audit showed the vendored preset already tracked ecc v2.0: 10/10 mainstream "new" skills, all 12 language rule ecosystems, `nanoclaw-repl`, etc. The one real gap — the 5-skill perf "optimization pack" — has now been **ported from ecc `main`** (`parallel-execution-optimizer`, `benchmark-optimization-loop`, `data-throughput-accelerator`, `latency-critical-systems`, `recursive-decision-ledger`) → preset now has 127 skills. Auto-installed via the `ecc/skills` recursive_dir. NanoClaw v2 full engine / plugin-distribution / AgentShield remain **deliberately not adopted** (large infra codeck already solves its own way). |
| **4 — MCP + memory** | ✅ Done (core) | `sequential-thinking` disabled by default; `busy_timeout=5000` + `synchronous=NORMAL` added to SQLite; context7/playwright rationale documented. Embeddings `sharp` fix still deferred (needs Docker build validation). |
| **5 — Security debt** | ✅ Verified | Both "critical" issues (#14 command injection, #15 SQL injection) were **already fixed** in code — marked FIXED in KNOWN-ISSUES. Broad sync→async fs refactor + coverage re-enable remain deferred (large, low-urgency). |

**Validation:** `npm run build` passes (frontend + backend) after each phase. No runtime/container testing performed (per instruction — the online container is in active use). The user validates end-to-end.

**Note on deps:** `npm install` was run to build (local `node_modules` was missing declared deps `marked`/`compression`); it reconciled `package-lock.json`. That lockfile change is left **uncommitted** for the user to review.

---

## Dependency graph

```
Phase 0 (CLI compat) ──► Phase 1 (Models) ──► Phase 2 (New features)
        │                                            │
        └──────────► Phase 4 (MCP + Memory) ◄────────┘
Phase 3 (ecc v2.0 resync) ── independent, can run in parallel after Phase 0
Phase 5 (security debt) ── independent, can run anytime
```

**Note:** The CLI pin bump is **safe today** — a live instance already runs `2.1.210` with Agent Teams working. Codeck only *references* `TeamCreate`/`TeamDelete` as system-prompt guidance (never invokes them as tools), so on ≥2.1.178 the model degrades gracefully and uses the `Agent` tool instead. Phase 0.1 is therefore a **quality cleanup** (stale guidance), not a prerequisite. Everything can be reordered.

---

## Phase 0 — CLI compatibility (BLOCKING) 🔴

**Goal:** Make codeck safe to run on Claude Code `2.1.210`, then raise the pin. No new features — pure compatibility.

### 0.1 Clean up stale Agent Teams guidance (quality, not a break)
`TeamCreate`/`TeamDelete` were removed in `2.1.178` (confirmed in the official CHANGELOG, not restored). Teams is now implicit (spawn teammates via the `Agent` tool `name` param + `SendMessage`); `team_name` is accepted-but-ignored. **Codeck references these only as prompt/guidance text, never as hard tool calls, so nothing breaks on 2.1.210 — the model already degrades gracefully.** This task removes the outdated instructions so we stop feeding the model guidance about tools that no longer exist (avoids confusion / wasted tokens).

- `apps/runtime/src/services/console.ts` — rewrite the Teams system-prompt injection (`--append-system-prompt`) to instruct `Agent(name:…, subagent_type:…, model:…)` + `SendMessage`, drop all `TeamCreate`/`TeamDelete` instructions.
- `apps/runtime/src/templates/presets/default/ecc/skills/team-builder/SKILL.md` — rewrite.
- `apps/runtime/src/templates/presets/default/scripts/teams-reminder-hook.mjs` — update guidance/payload assumptions (`team_name` deprecated in `TaskCreated`/`TaskCompleted`/`TeammateIdle`).
- `docs/ARCHITECTURE.md`, `docs/SERVICES.md`, `CLAUDE.md` — update Agent Teams sections.

### 0.2 Fix deprecated permission-rule syntax
Warnings at startup in `2.1.210`.

- `apps/runtime/src/templates/presets/default/ecc/settings.json` — `Write(/workspace/.codeck/**)` / `Write(/root/.claude/**)` → `Edit(…)`; audit bare `"Write"`, `"Glob"`, `"NotebookEdit"`. (Keep bare `Read`/`Edit`.)
- Grep for the same pattern in any programmatically-generated settings (permissions.ts / preset.ts).

### 0.3 Audit permission modes & hook schema
- Check `apps/runtime/src/services/permissions.ts` and hooks for `permission_mode: "default"` (now `Manual`; new `auto`/`dontAsk`). *(Grep clean so far — verify at runtime.)*
- Audit the hook battery in `ecc/settings.json` against the current ~30-event schema and new `hookSpecificOutput` fields. Confirm exit-code semantics (exit 2 = block) unchanged — they are. Watch the exact-match matcher change (`2.1.195`) for any hyphenated matchers.

### 0.4 Raise the pin & smoke-test
- `docker/Dockerfile.base:58` — `@anthropic-ai/claude-code@2.1.39` → `@2.1.210` (or latest verified).
- Rebuild base + app; boot a session; spawn a teammate; run a hook-triggering edit; run `--safe-mode` once to isolate customization issues.

**Deliverable:** repo pin matches deployed reality (`2.1.210`), preset guidance is current, no deprecation warnings.
**Risk:** Low — Teams already works on 2.1.210 (verified live); the pin in `Dockerfile.base` is just catching up to what's deployed. Guidance rewrite is text-only. Rollback = revert pin.
**Depends on:** nothing.

---

## Phase 1 — Models & routing 🟠

**Goal:** codeck knows about and routes to the current model generation.

- Update model IDs wherever referenced (config defaults, web UI model selector, proactive-agents, chat-api-handler): `claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5`, `claude-haiku-4-5`.
- `console.ts` Teams prompt: revisit hardcoded `model: 'sonnet'` for teammates (alias still resolves to Sonnet 5 — decide if that's the intended default).
- Adopt `fallbackModel` (up to 3 cascades) + optionally `enforceAvailableModels` / `requiredMinimumVersion` in preset settings.
- Effort: WIP already removed `effortLevel:"high"` / `--effort max` — good, since effort defaults to `high` on 4.8. Confirm no stale effort flags remain.
- Web UI: surface the new models in the session-launch model picker.

**Deliverable:** users can launch sessions on current models; sane fallback chain.
**Risk:** Low. **Depends on:** Phase 0 (so we test on the upgraded CLI).

---

## Phase 2 — Adopt new Claude Code features 🟡

**Goal:** stop leaving capability on the table. Pick per ROI; each item independently shippable.

- **Worktree isolation** (`isolation: "worktree"` / `EnterWorktree`) for parallel teammate file edits — reduces conflict risk that our resource-watchdog currently just monitors.
- **`/rewind` + checkpointing** awareness in UX/docs (note: does not track bash `rm`/`mv`).
- **New hooks** for cleanup: `post-session`, `Setup`, `PermissionRequest`/`PermissionDenied` — candidates to replace/augment our `SessionEnd` consolidation.
- **Subagents background-by-default** (`2.1.198`): reconcile our SubagentStart/Stop panel + `SendMessage`-resume caveat (KNOWN-ISSUES #23) with the new default.
- **Skills 2.0**: `context: fork`, nested `.claude/skills`, `disableBundledSkills` — evaluate for our ~130-skill preset (token cost at session start).
- **`--safe-mode`** documented as a support/diagnostic path.

**Deliverable:** targeted feature adoptions, each behind its own small PR.
**Risk:** Low–Medium per item. **Depends on:** Phase 0 (+ Phase 1 for model-aware pieces).

---

## Phase 3 — `ecc` v2.0 re-sync 🟡 (structural)

**Goal:** close the ~4-month gap with upstream `affaan-m/everything-claude-code` (now v2.0 "Agent Harness OS").

- Diff our vendored preset against ecc v2.0 layout (`agents/`, `skills/`, `rules/`, `.claude-plugin/`).
- Port net-new skills (pytorch-patterns, bun-runtime, nextjs-turbopack, mcp-server-patterns, business/content packs) and new language rule ecosystems — **only what fits codeck's audience**, don't blindly vendor 260+ skills.
- Evaluate NanoClaw v2 (model routing / observer-loop) and ecc's SQLite session store vs our own memory system — adopt ideas, not necessarily code.
- Consider **AgentShield** for our own security-review flow.
- Reconcile upstream hooks with codeck's custom hook battery (ours must win where they overlap).
- Update the `_attribution` block in `settings.json` with the new commit/version pinned.

**Deliverable:** preset refreshed to a chosen ecc v2.0 baseline, attribution updated.
**Risk:** Medium–High — layout changed; this is a migration, not a merge. Do it in a dedicated PR with a clear "what we took / what we skipped" note.
**Depends on:** Phase 0 (hook/settings compat). Independent of Phases 1–2.

---

## Phase 4 — MCP hygiene + memory 🟢

**Goal:** tighten the MCP stack and modernize memory.

- **context7**: pin a patched version (post-Feb-2026 "ContextCrush" fix); note free-tier cut.
- **sequential-thinking**: evaluate dropping (native thinking covers it; saves tool-schema tokens every session).
- **playwright**: evaluate the Playwright CLI+Skills path (~27k vs ~114k tokens/task) since our sessions have filesystem access.
- **token-optimizer**: verify its postinstall doesn't clobber our `settings.json` hooks.
- **Memory**: add WAL mode + jitter-retry to the SQLite layer; consider the working/episodic/procedural split; fix the `sharp`/`@xenova/transformers` embeddings degradation (currently BM25-only) — precompile in `Dockerfile.base` or use the Gemini fallback.

**Deliverable:** leaner MCP defaults, more robust memory.
**Risk:** Low–Medium. **Depends on:** Phase 0.

---

## Phase 5 — Security & tech-debt criticals 🔵 (parallel, anytime)

From `docs/KNOWN-ISSUES.md`:
- **Critical:** command injection in `services/auth-anthropic.ts` version check → `execFileSync(binary, [flag])`.
- **Critical:** SQL injection in `services/memory-indexer.ts` embedding dimension → validate numeric+bounded.
- Sync fs ops in routes → async; re-enable vitest coverage thresholds.

**Risk:** Low (well-scoped fixes). **Depends on:** nothing.

---

## Validation strategy (every phase)

1. `npm run build` (no Docker) — typecheck + bundle.
2. `npm test` — unit suite.
3. `npm run docker:rebuild` — boot the container.
4. Manual smoke: launch a session, trigger the changed path (teammate spawn / hook / model select), watch logs.
5. `claude --safe-mode` once per phase to confirm our customizations are the only variable.
6. **Update the corresponding `docs/*.md` in the same commit** (project rule).

## Risk register (top)

| Risk | Phase | Mitigation |
|---|---|---|
| Teams guidance rewrite changes agent behavior | 0 | End-to-end teammate spawn test before merge (low risk — already works on 2.1.210) |
| ecc v2.0 layout migration drifts our custom hooks | 3 | Dedicated PR, "took/skipped" manifest, ours-win on overlap |
| Embeddings rebuild bloats image | 4 | Gate behind build arg; Gemini fallback default |
| CLI bump surfaces new deprecation later | 0/2 | Set `requiredMinimumVersion`; monitor CHANGELOG |

## Suggested execution order

**0 → (1 ∥ 3 ∥ 5) → 2 → 4.** Start with Phase 0; it unblocks the pin bump and everything downstream.
