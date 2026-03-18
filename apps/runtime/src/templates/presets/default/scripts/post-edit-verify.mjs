#!/usr/bin/env node

/**
 * PostToolUse Hook — Run deterministic verification after code edits.
 *
 * Two-layer verification: this deterministic layer catches ~45% more errors
 * when combined with LLM review (IBM/HubSpot/Spotify research, 2026).
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, extname } from 'path';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const toolName = parsed.tool_name;
if (toolName !== 'Edit' && toolName !== 'Write') process.exit(0);

const filePath = parsed.tool_input?.file_path;
if (!filePath) process.exit(0);

const ext = extname(filePath).toLowerCase();
const results = [];

try {
  // TypeScript/JavaScript — typecheck
  if (['.ts', '.tsx'].includes(ext)) {
    // Find nearest tsconfig.json by walking up
    let dir = dirname(filePath);
    let tsconfig = null;
    for (let i = 0; i < 10; i++) {
      const candidate = `${dir}/tsconfig.json`;
      if (existsSync(candidate)) { tsconfig = candidate; break; }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (tsconfig) {
      try {
        execSync(`npx tsc --noEmit --pretty false -p "${tsconfig}" 2>&1`, { timeout: 10000, encoding: 'utf-8' });
      } catch (e) {
        // Filter to only errors in the edited file
        const output = (e.stdout || e.stderr || '').toString();
        const relevantErrors = output.split('\n')
          .filter(line => line.includes(filePath.split('/').pop()))
          .slice(0, 5)
          .join('\n');
        if (relevantErrors.trim()) {
          results.push(`TypeScript errors in ${filePath.split('/').pop()}:\n${relevantErrors}`);
        }
      }
    }
  }

  // Python — syntax check
  if (ext === '.py') {
    try {
      execSync(`python3 -m py_compile "${filePath}" 2>&1`, { timeout: 5000, encoding: 'utf-8' });
    } catch (e) {
      const output = (e.stdout || e.stderr || '').toString().trim();
      if (output) {
        results.push(`Python syntax error:\n${output.split('\n').slice(0, 3).join('\n')}`);
      }
    }
  }

  // JSON — validate
  if (ext === '.json') {
    try {
      execSync(`node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8'))" "${filePath}" 2>&1`, { timeout: 3000, encoding: 'utf-8' });
    } catch {
      results.push(`Invalid JSON: ${filePath.split('/').pop()}`);
    }
  }
} catch {
  // Never block the tool on hook errors
  process.exit(0);
}

if (results.length === 0) process.exit(0);

const context = results.join('\n\n');
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: `⚠ Verification found issues:\n${context}`,
  }
}));
