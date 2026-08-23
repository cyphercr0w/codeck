#!/usr/bin/env node
/**
 * orchestrator-guard — PreToolUse. The orchestrator directs; workers implement.
 *
 * During an autonomous harness run the main loop may be an expensive model
 * (Fable 5 at $10/$50). Measured on real sessions, ~85-90% of spend went to the
 * orchestrator doing the work itself rather than delegating — the single largest
 * source of runaway cost. This makes delegation structural instead of advisory:
 * the top-level loop cannot write code, so its only route forward is to spawn a
 * subagent on a cheaper tier.
 *
 * Discrimination (verified empirically 2026-07-21, CLI 2.1.211): PreToolUse
 * input carries `agent_id`/`agent_type` ONLY inside a subagent. Absent = the
 * top-level orchestrator. Subagents are never blocked — they are the workers.
 *
 * Deliberately NOT blocked for the orchestrator:
 *   - read-only Bash, so it can genuinely monitor (tests, logs, git status)
 *   - writes to .codeck/harness/**, so it can always record state, ESCALATE or
 *     close the run. Blocking these is how a guard deadlocks a sandbox.
 *
 * Fails OPEN on every error: a guard that cannot parse its input must not brick
 * the session.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const HARNESS = process.env.CODECK_HARNESS_DIR || '/workspace/.codeck/harness';
const CURRENT = join(HARNESS, 'current.json');

const allow = () => process.exit(0);

let input = '';
for await (const chunk of process.stdin) input += chunk;

let data;
try {
  data = JSON.parse(input);
} catch {
  allow();
}

// Subagent → this IS the delegated worker. Never block.
if (data.agent_id) allow();

const tool = data.tool_name || '';
if (!/^(Bash|Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) allow();

// Only govern autonomous harness runs; interactive work is untouched.
if (!existsSync(CURRENT)) allow();
let cur;
try {
  cur = JSON.parse(readFileSync(CURRENT, 'utf-8'));
} catch {
  allow();
}
if (!cur || cur.active !== true || !cur.taskId) allow();

// Escape hatch: `touch <taskDir>/orchestrator-guard.off` disables the guard for
// a run without editing settings, for when a task genuinely needs direct edits.
const taskDir = join(HARNESS, String(cur.taskId));
if (existsSync(join(taskDir, 'orchestrator-guard.off'))) allow();

// Harness bookkeeping is always permitted — see the deadlock note above.
const HARNESS_PATH_RE = /\.codeck[\/\\]harness[\/\\]/;
const filePath = String(data.tool_input?.file_path || data.tool_input?.notebook_path || '');
const bashCmd = String(data.tool_input?.command || '');
if (tool !== 'Bash' && HARNESS_PATH_RE.test(filePath)) allow();
if (tool === 'Bash' && HARNESS_PATH_RE.test(bashCmd)) allow();

// Bash: only mutation is blocked, so monitoring stays available.
const MUTATING_BASH = [
  /(^|[;&|]\s*)(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln)\s/,
  /(^|[;&|]\s*)git\s+(commit|push|merge|rebase|reset|checkout|apply|revert|clean|stash)\b/,
  /(^|[;&|]\s*)(npm|pnpm|yarn|pip|cargo|go)\s+(i|install|add|remove|uninstall|update|publish)\b/,
  /(^|[;&|]\s*)(sed|perl)\s+[^|;&]*-i\b/,
  /(^|[;&|]\s*)(tee|dd|truncate)\b/,
  /(^|[;&|]\s*)docker\s+(run|rm|stop|build|compose)\b/,
  />>?\s*[^\s|;&]/, // any output redirection into a file
  /\bcat\s*<<\s*['"]?EOF/, // heredoc write
];
if (tool === 'Bash' && !MUTATING_BASH.some((re) => re.test(bashCmd))) allow();

const what =
  tool === 'Bash' ? `the command \`${bashCmd.slice(0, 120)}\`` : `a direct ${tool} on \`${filePath}\``;

const reason = `ORCHESTRATOR GUARD: you are the top-level orchestrator of an autonomous harness run, so you do not implement — you direct, monitor and verify. Blocked: ${what}.

Delegate it with the Agent tool instead, picking the tier by difficulty (sonnet for routine implementation, opus only for genuinely hard design/debugging). Cost scales with who does the work, not with how much thinking you do about it.

The subagent starts with NO context from this conversation, so an underspecified brief is the main cause of failed delegation. Give it all six:
  1. GOAL — the observable end state, in one sentence.
  2. FILES — exact paths to read and to change; say what must NOT be touched.
  3. CONTEXT — the constraints, conventions and decisions already made that it cannot infer from the code.
  4. STEPS — the concrete sequence you want, not a vague objective.
  5. VERIFY — the exact command that proves it worked, and the expected output.
  6. REPORT — what to return: files changed, verification output, anything it could not do.

Still yours to do directly: read-only inspection, reading test/log output, judging results, updating harness state under .codeck/harness/, and deciding the next directive.

If this task genuinely requires you to edit directly, create ${join(taskDir, 'orchestrator-guard.off')} and retry.`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })
);
process.exit(0);
