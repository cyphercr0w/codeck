# Scheduled Loops — Design

**Status:** implemented on `feat/modernization-2026` (build green, not deployed). Preset `9.3.0`.

A **scheduled loop** is a Proactive Agent whose each cron tick runs the full
PO-driven **autonomous-harness** — plan → implement → review → audit →
evidence-gated DONE — inside an isolated control-plane, instead of a bare
one-shot `claude -p` run. It is Codeck's implementation of *loop engineering*: a
system that finds work, hands it to an agent, verifies with a **machine gate**,
records state, and stops or escalates on its own.

## Why (the gap)

Codeck already had both halves, unconnected:

- **Proactive Agents** (`services/proactive-agents/*`, `/api/agents`, `AgentsSection`):
  a real cron scheduler (`node-cron`) with per-cwd lock/queue, misfire detection,
  failure auto-pause, objective linting, and a headless `claude -p … --output-format
  stream-json` executor — but it fires **one-shot** runs with no stop condition,
  no independent verification, no persistent state.
- **Autonomous Harness** (`budget-guard`, `no-progress-guard`, `workflow-checkpoint`,
  `product-owner`/`grader`, `harness-resume-hook`): a governed, resumable,
  budget-capped **loop** with an evidence-gated DONE — but designed to run in the
  interactive web-terminal session.

The gap was not scheduling — it was that the scheduler dispatched ungoverned
runs. Scheduled Loops marry the two: **the cron cadence is the loop; each tick is
one bounded, verified unit of work.**

## Governance: full-harness per tick

Each tick runs the complete PO-driven harness. The **plan is pre-approved** — a
scheduled loop reads its fixed, vetted spec (`plan.md`) each tick rather than
re-planning (the article's "durable specification, reread every run"), so the
product-owner governs the REVIEW / AUDIT / DONE gates, not the PLAN gate.

## Architecture

### Data model (`proactive-agents/types.ts`)

`AgentConfig` gains `kind?: 'oneshot' | 'loop'` (undefined ⇒ oneshot, backward
compatible) and, for loops, a `loop: LoopConfig`:

| field | meaning |
|---|---|
| `goal` | observable stop condition ("all tests in test/auth pass") |
| `verifyCmd` | the **machine gate** — tests/build/lint. **Required** for loops. |
| `iterCap`, `costCapUsd` | → `budget.json` hard caps |
| `mode` | `scheduled` (one tick per cron) or `goal-driven` (self-continue to gate) |
| `permissionProfile` | `readonly` \| `safe-write` (default) \| `full` |
| `skill` | triage skill to load (default `scheduled-loop`) |

`ExecutionResult` gains `kind`, `accepted`, `escalated`, `costUsd` — read back
from the isolated state after each tick to power the acceptance metric.

### Executor branch (`proactive-agents/executor.ts`)

When `kind === 'loop'`, `buildLoopRun()`:

1. **Isolates** the control-plane via env passed to the headless run —
   `CODECK_HARNESS_DIR=<agentDir>/harness`, `CODECK_STATE_DIR=<agentDir>/state`.
   All harness hooks honor these, so the loop never collides with an interactive
   harness task at `/workspace/.codeck/harness`.
2. **Bootstraps** a fresh task per tick (drops the prior tick's state + stale
   markers): `current.json {active,taskId}`, `<taskId>/plan.md` (the loop spec),
   `progress.json` (triage + verify criteria), `budget.json {iterCap,costCapUsd}`,
   `overseer.json {mode:autonomous, phase:implement, planApproved:true}`.
3. Spawns `claude -p <loop-runner prompt>` with the isolated env. The prompt
   embeds the literal isolated paths and the permission-profile clause, and tells
   the agent to load the `scheduled-loop` + `autonomous-harness` skills, NOT
   re-plan, verify with the gate, record to memory, and ESCALATE to the inbox.

The `workflow-checkpoint` Stop hook keeps the headless session alive until DONE /
escalate / budget cap, so a single `-p` invocation drives the whole governed
loop. `timeoutMs` (loop default 30 min, ≤ 2 h) is the ultimate wall-clock kill.

### State layout

```
/workspace/.codeck/agents/<id>/
  config.json  state.json  executions/   ← existing proactive-agents
  harness/     ← current.json, <taskId>/{plan.md,progress.json,budget.json,overseer.json}
  state/       ← isolated review/audit/edit/no-progress markers
  inbox/       ← escalation .md files needing human judgment
```

### Hook isolation (the one code change to the harness)

`no-progress-guard.mjs`, `harness-resume-hook.mjs`, and `review-marker-hook.mjs`
hardcoded `/workspace/.codeck/...`; they now honor `CODECK_STATE_DIR` /
`CODECK_HARNESS_DIR` like `budget-guard`, `workflow-checkpoint`, `edit-tracker`,
and `autonomous-protocol-hook` already did. This is what routes a loop's
hooks to its own isolated dir.

## Safety — mapped to the loop-engineering checklist

| Rule | Mechanism |
|---|---|
| A machine can reject bad output | `verifyCmd` **required** at create; loop rejected without it |
| Hard iteration/cost/time cap | `budget-guard` (self-heal) + `timeoutMs` + cron cadence |
| The author isn't the judge | `product-owner`/`grader` have **no Write/Edit** and never built the work = the "fresh model". Both keep `Bash`, deliberately: the grader must run build/test/lint to verify evidence rather than trust the builder, and the PO writes its verdict to `overseer.json`. Their read-only discipline is enforced by instruction, not by the tool list — so a prompt-injected judge could in principle mutate state. |
| Irreversible actions need a human | `permissionProfile` denies deploy/push/publish/dep-upgrade unless `full`; ESCALATE instead |
| Unhandled work → triage inbox | `inbox/` + `GET /:id/inbox` |
| The repo remembers | `progress.json` + FTS5 memory + resume-hook (survives compaction/restart) |
| Measure cost per accepted change | `GET /:id/acceptance` — acceptanceRate + costPerAccepted |

**Watch-item:** the article warns "automate a narrow action before a decision."
The PO harness automates decisions, so keep the PO as gate-verdict over bounded,
verifiable actions and ensure ESCALATE is mandatory for the blacklist
(auth/payments/deploy/architecture/risky dep-upgrades) — encoded in the
`scheduled-loop` skill and the permission-profile clauses.

## API (extends `/api/agents`)

- `POST /` / `PUT /:id` accept `kind` (create only — immutable) + `loop`.
- `GET /:id/acceptance` → `LoopAcceptance` (loop only).
- `GET /:id/inbox` → `{ inbox: InboxEntry[] }`; `GET /:id/inbox/:file` → text (sanitized).

## Frontend (extends AgentsSection)

`AgentForm` gains a Standard/Loop type toggle (locked on edit) revealing goal,
verifyCmd, mode, permissions, and iter/cost caps. The card shows a `Loop` badge;
the detail view shows the loop config, an **Acceptance** panel (rate + cost per
accepted), and an **Inbox** panel of escalations.

## Files

- Backend: `proactive-agents/types.ts`, `executor.ts`, `scheduler.ts`, `proactive-agents.ts`, `routes/agents.routes.ts`
- Hooks: `scripts/{no-progress-guard,harness-resume-hook,review-marker-hook}.mjs`
- Preset: `ecc/skills/scheduled-loop/SKILL.md`, `manifest.json` (→ 9.3.0), `scripts/update-container.sh` (TARGET_VERSION)
- Frontend: `state/store.ts`, `components/agents/AgentForm.tsx`, `components/AgentsSection.tsx`
