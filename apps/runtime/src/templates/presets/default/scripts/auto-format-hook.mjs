#!/usr/bin/env node

/**
 * PostToolUse Hook — Deterministic auto-formatting after code edits.
 *
 * Runs the appropriate formatter based on file extension after Edit/Write.
 * Uses execFileSync (no shell) to avoid injection via filePath.
 *
 * Formatters: Biome (TS/JS/CSS/JSON), Ruff (Python), gofmt (Go), rustfmt (Rust).
 * Runs async to avoid blocking the agent. Silent on missing formatters.
 */

import { execFileSync } from 'child_process';
import { extname } from 'path';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const toolName = parsed.tool_name;
if (toolName !== 'Edit' && toolName !== 'Write') process.exit(0);

const filePath = parsed.tool_input?.file_path;
if (!filePath) process.exit(0);

const ext = extname(filePath).toLowerCase();

// [binary, ...args] — filePath appended as last arg. No shell involved.
const formatters = {
  '.ts':   ['biome', 'format', '--write'],
  '.tsx':  ['biome', 'format', '--write'],
  '.js':   ['biome', 'format', '--write'],
  '.jsx':  ['biome', 'format', '--write'],
  '.json': ['biome', 'format', '--write'],
  '.css':  ['biome', 'format', '--write'],
  '.py':   ['ruff', 'format'],
  '.go':   ['gofmt', '-w'],
  '.rs':   ['rustfmt'],
};

const args = formatters[ext];
if (!args) process.exit(0);

try {
  execFileSync(args[0], [...args.slice(1), filePath], { timeout: 5000, stdio: 'ignore' });
} catch {
  // Formatter not installed or failed — silent, never block
}
