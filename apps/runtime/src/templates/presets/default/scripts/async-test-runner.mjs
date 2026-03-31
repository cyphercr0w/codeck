#!/usr/bin/env node

/**
 * PostToolUse Hook — Async Background Test Runner (asyncRewake)
 *
 * Runs the project test suite in the background after file edits.
 * Only active when CODECK_AUTO_TEST=1 is set.
 * Exits with code 2 (asyncRewake) to wake the model with test results.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { extname, dirname } from 'path';

// Guard: only run when explicitly enabled
if (process.env.CODECK_AUTO_TEST !== '1') process.exit(0);

let input = '';
for await (const chunk of process.stdin) input += chunk;

let filePath = '';
try {
  const parsed = JSON.parse(input);
  const toolName = parsed.tool_name;
  if (toolName !== 'Edit' && toolName !== 'Write') process.exit(0);
  filePath = parsed.tool_input?.file_path || '';
} catch {
  process.exit(0);
}

if (!filePath) process.exit(0);

// Skip non-source files
const SKIP_EXTENSIONS = new Set([
  '.md', '.json', '.css', '.scss', '.less', '.yml', '.yaml',
  '.txt', '.env', '.gitignore', '.lock', '.toml', '.ini', '.cfg',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2'
]);

const ext = extname(filePath).toLowerCase();
if (SKIP_EXTENSIONS.has(ext)) process.exit(0);

// Walk up from file to detect project root and test runner
function findProjectRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(`${dir}/package.json`)) return { root: dir, type: 'node' };
    if (existsSync(`${dir}/go.mod`)) return { root: dir, type: 'go' };
    if (existsSync(`${dir}/pytest.ini`)) return { root: dir, type: 'python' };
    if (existsSync(`${dir}/pyproject.toml`)) {
      try {
        const content = readFileSync(`${dir}/pyproject.toml`, 'utf-8');
        if (content.includes('[tool.pytest') || content.includes('pytest')) {
          return { root: dir, type: 'python' };
        }
      } catch { /* continue */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const project = findProjectRoot(dirname(filePath));
if (!project) process.exit(0);

// Determine test command
let testCmd = null;
let testArgs = [];

if (project.type === 'node') {
  try {
    const pkg = JSON.parse(readFileSync(`${project.root}/package.json`, 'utf-8'));
    if (pkg.scripts?.test) {
      testCmd = 'npm';
      testArgs = ['test', '--', '--passWithNoTests'];
    }
  } catch { /* no test script */ }
} else if (project.type === 'python') {
  testCmd = 'pytest';
  testArgs = ['--tb=short', '-q'];
} else if (project.type === 'go') {
  testCmd = 'go';
  testArgs = ['test', './...'];
}

if (!testCmd) process.exit(0);

let testOutput = '';
let exitCode = 2; // asyncRewake — always wake the model

try {
  const result = execFileSync(testCmd, testArgs, {
    cwd: project.root,
    timeout: 60000,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  testOutput = result || '(no output)';
} catch (e) {
  // Tests failed or command error — still wake the model with output
  testOutput = [e.stdout, e.stderr].filter(Boolean).join('\n') || e.message || '(no output)';
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: `Background tests completed:\n${testOutput.slice(0, 4000)}`
  }
}));

process.exit(exitCode);
