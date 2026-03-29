#!/usr/bin/env node
/**
 * CwdChanged Hook — Auto-load project environment on directory change.
 *
 * When Claude navigates to a new project directory, this hook:
 * 1. Checks for .env file and injects a reminder about available env vars
 * 2. Detects project language for context
 */

import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const cwd = parsed.cwd || parsed.tool_input?.cwd || '';
if (!cwd) process.exit(0);

const hints = [];

// Check for .env file
const envPath = join(cwd, '.env');
if (existsSync(envPath)) {
  try {
    const envContent = readFileSync(envPath, 'utf-8');
    const varNames = envContent.split('\n')
      .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
      .map(l => l.split('=')[0].trim())
      .slice(0, 10); // max 10 to avoid bloat
    if (varNames.length > 0) {
      hints.push(`Project .env detected with: ${varNames.join(', ')}`);
    }
  } catch { /* non-fatal */ }
}

// Detect project type
const projectName = basename(cwd);
const indicators = {
  'TypeScript': ['tsconfig.json'],
  'Rust': ['Cargo.toml'],
  'Go': ['go.mod'],
  'Python': ['pyproject.toml', 'requirements.txt'],
  'Java': ['pom.xml', 'build.gradle'],
};

const detected = [];
for (const [lang, files] of Object.entries(indicators)) {
  if (files.some(f => existsSync(join(cwd, f)))) detected.push(lang);
}
if (detected.length > 0) {
  hints.push(`Project: ${projectName} (${detected.join(', ')})`);
}

if (hints.length === 0) process.exit(0);

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'CwdChanged',
    additionalContext: hints.join('\n'),
  }
}));
