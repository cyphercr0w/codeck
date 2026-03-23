#!/usr/bin/env node
/**
 * UserPromptSubmit Hook — Context Injector
 *
 * Before Claude processes each user message, this hook analyzes the message
 * and injects relevant context about available tools, MCP servers, and skills
 * that Claude should use for this type of task.
 *
 * This makes tool discovery mechanical rather than relying on Claude to
 * remember what's available.
 *
 * Output: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '...' } }
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const userMessage = (parsed.user_message || parsed.message || '').toLowerCase();
if (!userMessage || userMessage.length < 5) process.exit(0);

// ── Connected Integrations ──
// Check which integration tokens are in the environment and inject their instructions
const INTEGRATION_ENV_MAP = {
  vercel: { env: 'VERCEL_TOKEN', keywords: /vercel|deploy|domain|preview/ },
  github: { env: 'GH_TOKEN', keywords: /github|repo|pr|pull request|issue|clone/ },
  supabase: { env: 'SUPABASE_ACCESS_TOKEN', keywords: /supabase|database|db|migration|edge function|storage/ },
  stripe: { env: 'STRIPE_SECRET_KEY', keywords: /stripe|payment|subscription|invoice|charge/ },
  notion: { env: 'NOTION_API_KEY', keywords: /notion|page|database|workspace/ },
  cloudflare: { env: 'CLOUDFLARE_API_TOKEN', keywords: /cloudflare|dns|worker|pages|cdn/ },
  figma: { env: 'FIGMA_ACCESS_TOKEN', keywords: /figma|design|component|style/ },
};

// For GitHub, also check if gh CLI is authenticated (no env var needed)
const ghAuthenticated = (() => {
  try {
    return existsSync('/root/.config/gh/hosts.yml') || existsSync('/workspace/.codeck/credentials/gh/hosts.yml');
  } catch { return false; }
})();

// Detect task type from keywords
const signals = {
  implementation: /implement|build|create|add feature|write code|develop|make|construct|generate/,
  debugging: /bug|fix|error|crash|broken|not working|fail|issue|debug|wrong/,
  testing: /test|coverage|spec|tdd|unit test|e2e|integration test/,
  review: /review|audit|check|inspect|quality|security/,
  docs: /document|readme|explain|how does|architecture|doc/,
  frontend: /component|ui|css|style|design|layout|responsive|button|form|page|modal|frontend/,
  backend: /api|route|endpoint|service|database|migration|server|backend/,
  deployment: /deploy|docker|ci|cd|pipeline|release|publish|build image/,
  research: /research|investigate|compare|evaluate|find|search|look up|explore/,
  refactor: /refactor|clean|simplify|extract|rename|reorganize|split/,
};

const detected = [];
for (const [type, regex] of Object.entries(signals)) {
  if (regex.test(userMessage)) detected.push(type);
}

if (detected.length === 0) process.exit(0); // Can't determine task type

// Build context based on detected task types
const hints = [];

// Always remind about available MCP servers
const mcpHints = [];
if (detected.some(t => ['implementation', 'debugging', 'frontend', 'backend'].includes(t))) {
  mcpHints.push('Context7 (mcp__context7): look up current library docs before using unfamiliar APIs');
  mcpHints.push('ESLint (mcp__eslint__lint-files): lint changed files after edits');
}
if (detected.includes('frontend')) {
  mcpHints.push('Playwright (mcp__playwright): test UI changes in a real browser');
}
if (detected.some(t => ['implementation', 'debugging', 'review'].includes(t))) {
  mcpHints.push('Sequential Thinking (mcp__sequential-thinking): break down complex problems step-by-step');
}

if (mcpHints.length > 0) {
  hints.push('Available MCP tools for this task:');
  hints.push(...mcpHints.map(h => `  - ${h}`));
}

// Skill suggestions based on task type
const skillSuggestions = [];
const SKILLS_DIR = '/root/.claude/skills';
let availableSkills = new Set();
try {
  if (existsSync(SKILLS_DIR)) availableSkills = new Set(readdirSync(SKILLS_DIR));
} catch {}

const skillMap = {
  frontend: ['frontend-design', 'frontend-patterns'],
  backend: ['api-design', 'backend-patterns'],
  testing: ['tdd-workflow', 'verification-loop'],
  deployment: ['docker-patterns', 'deployment-patterns'],
  review: ['security-review', 'code-review'],
  refactor: ['coding-standards'],
};

for (const type of detected) {
  const candidates = skillMap[type] || [];
  for (const skill of candidates) {
    if (availableSkills.has(skill)) skillSuggestions.push(skill);
  }
}

if (skillSuggestions.length > 0) {
  hints.push(`Relevant skills available: ${skillSuggestions.map(s => '/learn ' + s).join(', ')}`);
}

// Workflow reminders based on task type
if (detected.includes('implementation') || detected.includes('refactor')) {
  hints.push('Workflow: implement → build/test → code-reviewer sub-agent → present results');
}
if (detected.includes('debugging')) {
  hints.push('Workflow: reproduce → diagnose root cause → fix → test → verify');
}

// ── Integration context injection ──
// If the user's message mentions a service, inject that integration's instructions
// Also suggest connecting if the token is missing but the service was mentioned
const INTEGRATIONS_DIR = '/workspace/.codeck/integrations';
const PRESET_INTEGRATIONS_DIR = '/workspace/codeck/apps/runtime/src/templates/presets/default/integrations';

for (const [name, config] of Object.entries(INTEGRATION_ENV_MAP)) {
  const mentioned = config.keywords.test(userMessage);
  const hasToken = !!process.env[config.env];
  const isGh = name === 'github' && ghAuthenticated;

  if (mentioned && (hasToken || isGh)) {
    // Integration connected + mentioned — inject instructions
    for (const dir of [INTEGRATIONS_DIR, PRESET_INTEGRATIONS_DIR]) {
      const instrPath = join(dir, `${name}.md`);
      if (existsSync(instrPath)) {
        try {
          const content = readFileSync(instrPath, 'utf-8').trim();
          if (content) hints.push(`\nConnected integration — ${name}:\n${content}`);
        } catch {}
        break;
      }
    }
  } else if (mentioned && !hasToken && !isGh) {
    // Service mentioned but NOT connected — suggest connecting
    hints.push(`The user mentioned ${name} but it's not connected. Suggest: "Go to Integrations and connect ${name} to enable this functionality."`);
  }
}

if (hints.length === 0) process.exit(0);

const context = [
  '<system-reminder>',
  'TASK CONTEXT — Tools and workflow for this request:',
  ...hints,
  'Use these tools proactively. Do not wait to be asked.',
  '</system-reminder>',
].join('\n');

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: context,
  }
}));
