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

import { existsSync, readdirSync } from 'fs';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const userMessage = (parsed.user_message || parsed.message || '').toLowerCase();
if (!userMessage || userMessage.length < 5) process.exit(0);

// Detect task type from keywords
const signals = {
  implementation: /implement|build|create|add feature|write code|develop|make|construct|genera/,
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
