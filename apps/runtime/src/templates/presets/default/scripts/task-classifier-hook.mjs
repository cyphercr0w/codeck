#!/usr/bin/env node
/**
 * UserPromptSubmit Hook — Task classifier.
 *
 * Tags the task with a type (feature/bugfix/refactor/research/migration/ops/
 * debug/trivial) by deterministic keyword heuristic and points the agent at the
 * matching playbook in rules/base/playbooks.md. Makes the always-on protocol
 * ADAPTIVE without a model call. Message-layer only (cache-safe).
 */

let input = '';
for await (const chunk of process.stdin) input += chunk;

let data = {};
try { data = JSON.parse(input); } catch { /* empty */ }

if (process.env.CLAUDE_CODE_TEAM_NAME) process.exit(0); // teammates skip

const prompt = (data.prompt || data.user_prompt || '').toString().toLowerCase();
if (!prompt.trim()) process.exit(0);

const trivial = /^\s*(y|yes|ok|okay|dale|si|sí|no|gracias|thanks|continue|continúa|sigue|go|yep|👍)\s*[.!]?\s*$/i;
if (trivial.test(prompt)) process.exit(0);

// Ordered rules — first match wins. Keywords in EN + ES.
const rules = [
  ['bugfix',    /\b(fix|bug|broken|crash|regression|no funciona|falla|arregl|se rompe|error de)\b/],
  ['debug',     /\b(debug|diagnose|why is|why does|root cause|trace|por qué|diagnostic|investiga el error)\b/],
  ['migration', /\b(migrat|upgrade|port|convert|across all|every (file|occurrence)|sweep|codemod|migrar|actualizar todo|en todos)\b/],
  ['refactor',  /\b(refactor|clean ?up|rename|reorganiz|simplif|extract|dedupe|limpiar|reorganiz|renombrar)\b/],
  ['ops',       /\b(deploy|docker|compose|ci\/?cd|pipeline|release|infra|kubernetes|nginx|systemd|desplegar|despliegue)\b/],
  ['research',  /\b(research|investigat|compare|evaluate|find out|how does|what is the best|pros and cons|investig|analiz|comparar|averigua)\b/],
  ['feature',   /\b(add|implement|build|create|new (feature|endpoint|page|component)|support for|agreg|implement|crear|nueva|construir)\b/],
];

let type = 'feature';
for (const [name, re] of rules) { if (re.test(prompt)) { type = name; break; } }

// Short one-line reminder per type (full steps live in playbooks.md).
const oneLiners = {
  feature:   'thin end-to-end slice first, tests alongside; review→audit→visual-verify before done.',
  bugfix:    'REPRODUCE with a failing test first; fix the root cause, not the symptom; keep the test as evidence.',
  refactor:  'characterization tests FIRST; behavior-preserving small steps; prove the diff is structural only.',
  research:  'fan out read-only subagents in parallel; adversarially verify load-bearing claims; deliver cited + hedged.',
  migration: 'discover the FULL work-list first (no silent truncation); prove the pattern on one site; verify each — a /harness candidate.',
  ops:       'clarify blast radius + rollback BEFORE acting; dry-run first; NEVER touch the live container unauthorized.',
  debug:     'hypothesis → instrument → bisect to the root cause, then switch to the bugfix playbook.',
};

const banner = `TASK TYPE: ${type}. Follow the "${type}" playbook (rules/base/playbooks.md): ${oneLiners[type] || ''} For large multi-step work, run the autonomous-harness skill (/harness) — resumable, budget-capped.`;

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: banner,
  },
}));
