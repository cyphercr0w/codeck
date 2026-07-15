# Level-Up Roadmap 2026 — making codeck a best-in-class agent system

**Status:** Research synthesis (proposed) · **Created:** 2026-07-15 · Companion to `MODERNIZATION-2026.md`

Synthesized from 3 deep web-research passes (context engineering & memory, evals/observability/reliability/guardrails, elite Claude Code setups), cross-verified against primary sources. This is *beyond* catch-up — it's the frontier.

## Implementation status (2026-07-15 · branch `feat/modernization-2026`)

The **Autonomous Operator Protocol** is now the default behavior of the `recommended` preset — the agent clarifies to zero ambiguity, plans surgically (one approval gate), implements with subagents + memory, reviews, audits, and delivers only on evidence, iterating until done — **without being told each time**.

**Done (baked into the preset):**
- ✅ Protocol as default — `rules/base/workflow.md` + `autonomous-protocol-hook.mjs` (UserPromptSubmit, cache-safe injection each task).
- ✅ Clarify-to-zero-ambiguity gate (AskUserQuestion, one batched round) — calibrated: full protocol on non-trivial tasks, direct on trivial.
- ✅ One plan-approval checkpoint before implementation.
- ✅ Review **and** Audit gate enforced — `workflow-checkpoint.mjs` blocks Stop until both markers exist; criteria "start false".
- ✅ Independent `grader` agent (no Write/Edit) + `visual-verifier` agent (browser e2e via CDP).
- ✅ No-progress/loop guard (`no-progress-guard.mjs`).
- ✅ Prompt-injection defense — spotlighting of WebFetch/WebSearch as untrusted data (`tool-result-compressor.mjs`).
- ✅ `ENABLE_TOOL_SEARCH` env + stronger credential deny rules.
- ✅ Lexical-weighted RRF (0.6 BM25 / 0.4 vector) for the code corpus.
- ✅ Model-routing **guidance** (haiku/sonnet/opus by task) in the protocol; CDP screencast already capped at 1280px/q60.
- ✅ **Complete harness**: adaptive task classifier + per-type playbooks (`rules/base/playbooks.md`); long-running `/harness` mode (`autonomous-harness` skill) with resumable on-disk state (`.codeck/harness/`, survives compaction/restart/rebuild via `harness-resume-hook`) and git-anchored increments; **hard budget/iteration kill switch** (`budget-guard.mjs`, PreToolUse deny at cap).
- ✅ **Agent Teams launch checkbox removed** — subagents-only default (read-parallel/write-serial); teams kept as opt-in-advanced (plumbing intact, not surfaced).

**Scaffolded / deferred (need runtime validation or larger build — not yet implemented):**
- ◻ Per-agent `model:` frontmatter across all 69 agents (mechanical pass; routing works via protocol guidance meanwhile).
- ◻ Cross-encoder reranker stage + trigram FTS5 identifier column (native-dep / schema-migration; RRF re-tune shipped as the safe first step).
- ◻ Self-hosted OTel `gen_ai.*` tracing + pass^k eval harness + failure→regression loop.
- ◻ Native `/memories` backend + empirically-gated agent-authored skills.
- ◻ PreCompact high-recall compaction contract; contradiction-resolution in consolidation.
- ◻ Native sandbox egress allowlist — intentionally NOT added (codeck reverted bubblewrap/env-scrub; Docker is the boundary, credentials covered by `permissions.deny`).

---

---

## The governing principle: read-parallel, write-serial

Two primary sources (Anthropic *Multi-Agent Research System*, 2025-06-13; Cognition *Don't Build Multi-Agents*, 2025-06-12) define the field: **multi-agent parallelism wins for reading/investigation and hurts for writing/implementation.** Anthropic's multi-agent research beat single-agent Opus by 90.2% but burned ~15× the tokens; parallel *writers* make conflicting implicit decisions and produce unmergeable output. Anthropic itself: "coding is less parallelizable than research," and reserves synthesis/writing to a single agent.

**codeck's posture:** default to the cheapest tier (single agent → read/explore subagents → teams, ascending cost); reserve Agent Teams for genuinely independent workstreams (multi-file audits, fan-out research, candidate generation); keep implementation/synthesis single-agent; show an estimated-cost preview before a team launch.

## Where codeck already stands (confirmed strengths — don't regress)

- Hybrid retrieval with **RRF fusion** (BM25 + vector) — the 2026 production default.
- **Progressive disclosure** search (`/api/memory/search/compact`) = just-in-time retrieval.
- **KV-cache-aware** context injection at `UserPromptSubmit` (not baked in CLAUDE.md) — exactly right per Anthropic's cache guidance.
- **Consolidation with Ebbinghaus decay**; tiered HOT/WARM/COLD memory; PreCompact/PostCompact hooks.
- Substrate for reliability already present: `workflow-checkpoint.mjs`, `resource-watchdog.ts`, `cost-tracker.js`, `dangerous-cmd-guard.mjs`, `evaluate-session.js`, `skill-proposal-hook.mjs`.

## The 5 frontier gaps

1. No **reranking** stage in retrieval. 2. **Token tax** unmeasured (127 skills likely overflow the skill-listing budget; MCP schema bloat). 3. No **independent grader** / evidence-gated done-criteria. 4. No **architectural prompt-injection defense** on the browse/WebFetch path. 5. No **structured trace/eval** layer (OTel, pass^k).

---

## P0 — Quick high-leverage wins (low effort, high impact)

- **Measure & trim the token tax.** Run `/doctor` + `/context`. With 127 skills the listing budget (~1% of window) almost certainly overflows → Claude Code *silently drops the least-used skills' descriptions*, breaking routing. Set `skillOverrides` (low-value ecc skills → `name-only`/`off`), consider `skillListingBudgetFraction`, enable **`ENABLE_TOOL_SEARCH`** + mark rare MCP tools `defer_loading: true` (~85% schema-overhead reduction, Anthropic). *Source: code.claude.com/docs/en/skills, /mcp tool search 2026-01-14.*
- **Per-agent model routing + effort tiers** across all 69 preset agents: read/search/test/lint → `haiku` + `effort: low`; implementation → `sonnet` + `medium/high`; architecture/review/security → `opus` + `xhigh`. Real **5×** cost delta (Haiku $1/$5 vs Opus $5/$25), no quality coupling since subagents return only summaries. *(Correct the stale "15× cheaper" claim — it's 5× now.)*
- **Native Claude Code sandbox block in `ecc/settings.json`** (defense-in-depth inside Docker): `denyRead` on credentials (`~/.claude/.credentials*`, `.codeck/.env`, `.ssh`), egress `allowedDomains` allowlist, `credentials: mask` for the Anthropic token, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`. Defuses the Nx "s1ngularity" class of attack. *Source: anthropic.com/engineering/claude-code-sandboxing (2025-10-20).*
- **Cap CDP screenshots at ~1080p** before feeding frames to the model — uncapped high-res vision costs up to ~4,784 tokens/frame on Opus 4.8; a screencast loop is a silent cost sink. Cheapest single fix on the browser path.
- **Protect the prompt-cache prefix.** Verify `memory-context.ts`'s marker-block injection into workspace CLAUDE.md is **not** inside the cached prefix (a mid-session CLAUDE.md edit silently won't take effect *and* risks cache). Keep dynamic content on the `UserPromptSubmit` path; prefer subagent **forks** over fresh spawns to inherit the warm cache. Cache read = 0.1× input. *Source: code.claude.com/docs/en/prompt-caching.*

## P1 — Reliability & safety core (biggest quality/safety wins)

- **Independent grader subagent + evidence-gated done-criteria.** Add `ecc/agents/grader.md` with **no Write/Edit/Bash**, invoked from the Stop-hook cluster; it reads only final artifacts + task spec (a context that never saw the build). Extend `workflow-checkpoint.mjs` so criteria **"start false"** and each requires a linked evidence artifact (test output, diff) before flipping true. Intrinsic self-correction fails ("self-correction blind spot") — grounding in an external check is the fix. *Source: Anthropic long-running harness 2025-11-26; arXiv:2507.02778.*
- **No-progress detector + hard cost-budget kill switch.** New `PostToolUse` hook hashing recent tool-call signatures → block (exit 2) on N near-identical repeats or unchanged repo state across M iterations. Promote `cost-tracker.js` from telemetry to a `PreToolUse` budget enforcer that terminates *before* the next call. Prevents runaway loops (the "call a broken tool 400× in 5 min" failure). *Source: Anthropic 2025-11-26.*
- **Dual-LLM + spotlighting on the web/research path** (largest unaddressed safety gap). Ensure the `researcher`/WebFetch subagent has **no actor tools** (it's the quarantined LLM — subagents only return a summary). Extend `tool-result-compressor.mjs` (already on `WebFetch|WebSearch`) to **spotlight** untrusted content (delimit/datamark) and tag provenance — drops indirect-injection success from >50% to <2%. *Source: OWASP LLM01:2025; CaMeL arXiv:2503.18813; Willison 2025-06-13.*
- **Memory poisoning defense.** Tag every memory entry with its source in `memory.ts`; **block WebFetch-origin content from durable promotion** without a review gate; prefer append-with-decay over destructive rewrite (avoids "context collapse"). *Source: ACE arXiv:2510.04618.*

## P2 — Retrieval & memory upgrade (also resolves the embeddings pain)

- **Add a reranking stage** — over-retrieve top-50 from RRF, rerank to top-k with a small self-hosted cross-encoder (e.g. `bge-reranker-base` via ONNX, runs on ~50 pairs). Biggest single retrieval-quality lift (Anthropic Contextual Retrieval: reranking took failure from 2.9%→1.9%) and directly counters context rot. *Source: anthropic.com/engineering/contextual-retrieval (2024-09-19); Voyage rerank-2.5.*
- **Re-tune RRF toward lexical for a code corpus.** codeck's current 0.4 BM25 / 0.6 vector is likely backwards for code — BM25 wins on identifiers/error codes/symbols (`torch.nn.functional.cross_entropy`, `0x80070005`). A/B-test 0.6/0.4. Add a **non-stemming `trigram`/`unicode61` FTS5 column** for identifier matching (the current `porter` tokenizer stems `getDocument`→`getdocu`). *Source: tianpan.co 2026-04-12; FreshStack arXiv:2504.13128.*
- **Make BM25 + rerank the PRIMARY path, embeddings OPTIONAL.** This resolves the `sharp`/`@xenova/transformers` native-build pain as a **non-blocker**: if embeddings are unavailable, BM25+rerank still delivers near-hybrid quality. If keeping embeddings, prefer `arctic-embed-s` (retrieval-tuned ONNX) or Model2Vec static (~30 MB, numpy-only); use Matryoshka to keep the existing `FLOAT[384]`. *Source: digitalapplied.com 2026; MinishLab/model2vec.*
- **Upgrade PreCompact into a high-recall compaction contract** — before compaction, extract (a) open decisions, (b) unresolved bugs, (c) files touched → daily journal + restorable `state/session-<id>.json`. Enforce **restorability** in `tool-result-compressor.mjs`: replace large tool bodies with a `chunk_id`/path the agent can re-expand, never a lossy prose summary. *Source: Anthropic context engineering 2025-09-29; Manus 2025-07-18.*
- **Add contradiction-resolution to consolidation** (supersede stale `MEMORY.md` facts, don't append conflicts) + **eviction-with-restorability** (decayed chunks → `archive/cold/`, out of the hot FTS5 index). *Source: LangMem; Zep temporal validity 2025-01-22.*

## P3 — Differentiators (what makes codeck uniquely crack)

These leverage what cloud IDEs *can't* match: a persistent container + a real browser + owned infra.

- **Semantic screenshot-diff verification subagent** (flagship). On each change: navigate the CDP preview, capture baseline vs current, pull the **DOM + accessibility tree** via CDP, and gate "feature complete" on a *semantic* verdict (not pixels — kills false positives). Anthropic explicitly names "browser screenshot compared against a design" as a valid check; few setups have it natively. Store baselines in the workspace; run headless in loops. *Source: Anthropic best-practices; testdino 2026-02-28.*
- **Autonomous "overnight build" harness.** Initializer agent creates `claude-progress.txt` + a JSON list of e2e requirements + initial commit; each coding agent reads progress → does ONE feature → **verifies end-to-end via Playwright as a human user** → commits → updates progress. codeck uniquely has all four pieces (persistent workspace, subagent split, browser e2e = the exact tool Anthropic mandates, background longevity). Add container-level **budget/iteration caps** + a spend meter. *Source: anthropic.com/engineering/effective-harnesses-for-long-running-agents (2025-11-26).*
- **Self-hosted observability + eval loop** (zero data leaving the VPS):
  - **OTel `gen_ai.*` trace emission** → `services/tracing.ts` writing `/workspace/.codeck/traces/*.jsonl`, populated from existing hooks (`SubagentStart/Stop`→`invoke_agent`, `PreToolUse/PostToolUse`→`execute_tool`, `Stop`→rollup with `cost-tracker` numbers). Add **retry-count** + **memory-relevance** fields. Exportable to Langfuse/Datadog later for free. *Source: OTel GenAI semconv; Braintrust 2026-06-21.*
  - **Offline eval harness with pass^k** — `/workspace/.codeck/evals/` (containerized task + oracle test, Terminal-Bench format), a runner (consider **Inspect**, which can drive Claude Code as the subject), each case run **k=5–8×** → report pass^k (reliability, not peak). Auto-capture failures from `evaluate-session.js` into a regression folder. *Source: Anthropic Demystifying Evals 2026-01-09; Terminal-Bench 2.0.*
- **Native `/memories` backend + empirically-gated agent-authored skills.** Map Anthropic's memory tool onto `/workspace/.codeck/` (persistent, git-versioned, browsable in the web UI — most hosted offerings keep memory opaque). Gate `skill-proposal-hook.mjs`: a proposed skill becomes active **only if it improves/ties on 1–2 eval cases** (DGM/SICA discipline) — turns "detect a pattern" into validated learning. *Source: Anthropic memory tool 2025-09-29; DGM arXiv:2505.22954.*
- **Optional hardening:** one-flag **gVisor** runtime; **default-deny egress + allowlist in `docker/compose.yml`**; bundle self-hosted **Langfuse**. "Observable autonomous agents, zero data leaving your VPS."

## P4 — Bigger architectural bets (evaluate before committing)

- **Agent SDK migration** — move orchestration from shelling the CLI to `@anthropic-ai/claude-agent-sdk`: hooks-as-callbacks, `session_id` capture for resume/**fork**, the `Monitor` tool onto codeck's console streaming, preset via `settingSources`. (Confirm `package.json` isn't still on the deprecated `@anthropic-ai/claude-code` SDK name — the CLI package stays that name, the SDK moved.)
- **Structured outputs** (`--json-schema` / `output_format`) to replace brittle text-parsing for memory writes, task summaries, agent-config generation — with auto-retry on mismatch.
- **Native context-editing beta** (`clear_tool_uses_20250919`) to replace hand-rolled `tool-result-compressor` logic (verify beta availability for a subscription-auth deployment first).

## What NOT to chase (hype — flagged by the research)

- **Weight-level / recursive self-improvement toward "ASI"** — framing, not evidence. Stay in the empirically-gated, *component-level* lane (skills/memory/tools), which is also safer given memory-poisoning risk.
- **Chasing a specific memory framework's LOCOMO score** — accuracy leaderboards (Mem0 vs Zep) are contested and config-dependent; only the *efficiency* wins (~90% token/latency cut vs full-context) are reproducible.
- **Ensembles as a general accuracy booster** — they improve *selection* but do **not** exceed the base-model ceiling. Use execution-grounded consensus only for high-stakes diffs, behind a flag (multiplies cost).
- **Multi-agent for tightly-coupled coding** — read-parallel, write-serial. Most teams reach for multi-agent too early and pay 5–10× for it.

## Doc hygiene (per CLAUDE.md rule)

`docs/API.md` and parts of `docs/SERVICES.md` still describe removed `services/teams.ts` / `tmux-bridge.ts` / `/api/teams`. Teams are now native Claude Code `Agent`/`SendMessage`. Sweep for stale references.

---

## Top 8 bets, in order

1. Measure & trim the token tax (`/doctor`, `skillOverrides`, tool search). — P0
2. Per-agent model routing + effort tiers across 69 agents. — P0
3. Independent grader + evidence-gated done-criteria. — P1
4. No-progress detector + hard cost-budget kill switch. — P1
5. Dual-LLM + spotlighting + provenance on the web path. — P1
6. Reranking stage + lexical-weighted RRF (embeddings optional). — P2
7. Semantic screenshot-diff verification via CDP. — P3 (differentiator)
8. Self-hosted OTel tracing + pass^k eval harness. — P3

*Sourcing note: every item traces to a dated primary source in the research pass. Items depending on Anthropic-internal eval numbers, contested benchmark leaderboards, or future-dated (2026) arXiv IDs are directionally reliable but should be re-verified before load-bearing use.*
