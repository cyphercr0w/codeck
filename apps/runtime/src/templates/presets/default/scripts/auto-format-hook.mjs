#!/usr/bin/env node

/**
 * PostToolUse Hook — Deterministic auto-formatting after code edits.
 *
 * Runs the appropriate formatter based on file extension after Edit/Write.
 * This is 100% reliable (vs CLAUDE.md style rules at ~70% compliance).
 *
 * Formatters (by speed):
 *   Biome   — TS/JS/JSX/TSX/JSON/CSS (10-25x faster than Prettier)
 *   Ruff    — Python (30x faster than Black)
 *   gofmt   — Go (built-in)
 *   rustfmt — Rust (built-in)
 *
 * Runs async to avoid blocking the agent. Silent on missing formatters.
 */

import { execSync } from 'child_process';
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

const formatters = {
  // Biome for JS/TS ecosystem
  '.ts':   'npx @biomejs/biome format --write',
  '.tsx':  'npx @biomejs/biome format --write',
  '.js':   'npx @biomejs/biome format --write',
  '.jsx':  'npx @biomejs/biome format --write',
  '.json': 'npx @biomejs/biome format --write',
  '.css':  'npx @biomejs/biome format --write',
  // Ruff for Python
  '.py':   'ruff format',
  // Go
  '.go':   'gofmt -w',
  // Rust
  '.rs':   'rustfmt',
};

const cmd = formatters[ext];
if (!cmd) process.exit(0);

try {
  execSync(`${cmd} "${filePath}" 2>/dev/null`, { timeout: 5000 });
} catch {
  // Formatter not installed or failed — silent, never block
}

process.exit(0);
