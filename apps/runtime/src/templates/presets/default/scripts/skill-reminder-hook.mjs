#!/usr/bin/env node

/**
 * PreToolUse hook for Edit/Write — reminds the agent about relevant skills
 * based on the file extension being edited.
 *
 * Output format: JSON to stdout with { result: "approve" } to allow the tool,
 * plus a "description" field that gets shown to the agent as context.
 *
 * This hook NEVER blocks — it always approves. It only informs.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { extname, basename } from 'path';

// Read hook input from stdin
let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try {
  parsed = JSON.parse(input);
} catch {
  // Can't parse input — approve silently
  console.log(JSON.stringify({ result: 'approve' }));
  process.exit(0);
}

const toolName = parsed.tool_name || '';
const filePath = parsed.tool_input?.file_path || '';

// Only act on Edit and Write
if (toolName !== 'Edit' && toolName !== 'Write') {
  console.log(JSON.stringify({ result: 'approve' }));
  process.exit(0);
}

if (!filePath) {
  console.log(JSON.stringify({ result: 'approve' }));
  process.exit(0);
}

// ── Extension → Skill mapping ──

const ext = extname(filePath).toLowerCase();
const name = basename(filePath).toLowerCase();

const SKILL_MAP = {
  // Frontend
  '.tsx': ['frontend-design', 'frontend-patterns'],
  '.jsx': ['frontend-design', 'frontend-patterns'],
  '.css': ['frontend-design'],
  '.scss': ['frontend-design'],
  '.svelte': ['frontend-design', 'frontend-patterns'],
  '.vue': ['frontend-design', 'frontend-patterns'],
  '.html': ['frontend-design'],

  // Backend / API
  '.routes.ts': ['api-design', 'backend-patterns'],
  '.routes.js': ['api-design', 'backend-patterns'],
  '.controller.ts': ['api-design', 'backend-patterns'],
  '.controller.js': ['api-design', 'backend-patterns'],

  // Testing
  '.test.ts': ['tdd-workflow', 'e2e-testing'],
  '.test.js': ['tdd-workflow', 'e2e-testing'],
  '.spec.ts': ['tdd-workflow', 'e2e-testing'],
  '.spec.js': ['tdd-workflow', 'e2e-testing'],
  '.test.tsx': ['tdd-workflow', 'e2e-testing'],
  '.test.jsx': ['tdd-workflow', 'e2e-testing'],

  // Database
  '.sql': ['database-migrations', 'postgres-patterns'],
  '.migration.ts': ['database-migrations'],
  '.migration.js': ['database-migrations'],

  // Docker / Deployment
  'dockerfile': ['docker-patterns', 'deployment-patterns'],
  '.yml': [], // checked below for compose/ci files
  '.yaml': [],

  // Python
  '.py': ['python-patterns'],

  // Go
  '.go': ['golang-patterns'],

  // Security-related filenames
  'auth': ['security-review'],
  'crypto': ['security-review'],
  'token': ['security-review'],
  'session': ['security-review'],
  'password': ['security-review'],
};

// Determine relevant skills
let skills = [];

// Check exact extension match (with compound extensions like .test.ts)
for (const [pattern, patternSkills] of Object.entries(SKILL_MAP)) {
  if (pattern.startsWith('.')) {
    // Extension match
    if (filePath.endsWith(pattern)) {
      skills.push(...patternSkills);
    }
  } else {
    // Filename contains match
    if (name.includes(pattern)) {
      skills.push(...patternSkills);
    }
  }
}

// Special cases for YAML files
if (ext === '.yml' || ext === '.yaml') {
  if (name.includes('compose') || name.includes('docker')) {
    skills.push('docker-patterns', 'deployment-patterns');
  }
  if (name.includes('ci') || name.includes('github') || name.includes('pipeline')) {
    skills.push('deployment-patterns');
  }
}

// Deduplicate
skills = [...new Set(skills)];

// Filter to only skills that actually exist
const SKILLS_DIR = '/root/.claude/skills';
if (existsSync(SKILLS_DIR)) {
  const available = new Set(readdirSync(SKILLS_DIR));
  skills = skills.filter(s => available.has(s));
}

if (skills.length === 0) {
  console.log(JSON.stringify({ result: 'approve' }));
  process.exit(0);
}

// Build reminder message
const skillList = skills.map(s => `\`/learn ${s}\``).join(', ');
const description = `Available skills for this file type: ${skillList}. Load if not already done.`;

console.log(JSON.stringify({
  result: 'approve',
  description,
}));
