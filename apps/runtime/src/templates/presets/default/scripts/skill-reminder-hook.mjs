#!/usr/bin/env node

/**
 * PreToolUse hook for Edit/Write — blocks edits until relevant skills are loaded.
 *
 * Detects file type, maps to required skills, checks if they were already loaded
 * this session (via state file). If not loaded, DENIES the edit and tells the
 * agent to load the skill first. After loading, the state file is updated and
 * subsequent edits are approved.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { extname, basename, join } from 'path';

const STATE_DIR = '/workspace/.codeck/state';
const LOADED_SKILLS_FILE = join(STATE_DIR, 'loaded-skills.json');

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
  process.exit(0);
}

// Check which skills were already reminded this session (avoid nagging)
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
let remindedSkills = new Set();
try {
  if (existsSync(LOADED_SKILLS_FILE)) {
    const data = JSON.parse(readFileSync(LOADED_SKILLS_FILE, 'utf-8'));
    if (Array.isArray(data)) remindedSkills = new Set(data);
  }
} catch { /* start fresh */ }

// Filter to skills not yet reminded about
const newSkills = skills.filter(s => !remindedSkills.has(s));

if (newSkills.length === 0) {
  // Already reminded — don't nag, approve silently
  process.exit(0);
}

// Mark these skills as reminded so we don't block again
for (const s of newSkills) remindedSkills.add(s);
try {
  writeFileSync(LOADED_SKILLS_FILE, JSON.stringify([...remindedSkills]));
} catch { /* non-fatal */ }

// First encounter — BLOCK the edit. Agent must load skill first.
const skillList = newSkills.map(s => `/learn ${s}`).join(', ');

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: `STOP — load relevant skills before editing this file: ${skillList}. Run the /learn command first, then retry your edit.`,
  }
}));
