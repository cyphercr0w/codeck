#!/usr/bin/env node
/**
 * PostToolUse Hook (Edit|Write) — Tracks file modifications.
 *
 * Maintains a counter of files edited/written during the current work cycle.
 * The workflow-checkpoint Stop hook reads this to decide if review is needed.
 * Counter resets when a code review completes (review-marker written).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';

const STATE_DIR = process.env.CODECK_STATE_DIR || '/workspace/.codeck/state';
const EDIT_TRACKER = join(STATE_DIR, 'edit-tracker.json');

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const toolName = parsed.tool_name || '';
const sessionCwd = parsed.cwd || process.cwd();
let filePath = parsed.tool_input?.file_path || '';

// Bash writes to source files (cat > f.ts, sed -i, tee, cp/mv into code) ALSO
// count — otherwise code written through the shell bypasses the review/audit gate
// (fail-open). Derive the target path from the command and treat it like an edit.
if (toolName === 'Bash') {
	const cmd = String(parsed.tool_input?.command || '');
	// A write operator (redirection / tee / sed -i / cp / mv / dd) …
	const hasWrite = /(?:>>?|\btee\b|\bsed\b[^|;&]*-i|\bcp\b|\bmv\b|\bdd\b)/i.test(cmd);
	if (!hasWrite) process.exit(0);
	// … targeting a source-code file (checked by extension via a token split —
	// far more robust than one big regex).
	const SRC_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'rb', 'php', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'swift', 'kt', 'kts', 'scala', 'css', 'scss', 'less', 'html', 'vue', 'svelte', 'sql', 'sh', 'bash', 'lua', 'dart', 'ex', 'exs']);
	let target = null;
	for (const tok of cmd.split(/[\s'"|;&()<>]+/)) {
		if (!tok.includes('.')) continue;
		if (SRC_EXT.has(tok.split('.').pop().toLowerCase())) { target = tok; break; }
	}
	if (!target) process.exit(0);
	if (/\.codeck[\\/]|\.claude[\\/]/.test(target)) process.exit(0);
	// Absolutize a relative target against the session cwd.
	if (!target.startsWith('/') && !/^[A-Za-z]:/.test(target)) {
		target = `${sessionCwd.replace(/[\\/]$/, '')}/${target}`;
	}
	filePath = target;
} else if (!/^(Edit|Write|MultiEdit)$/.test(toolName)) {
	process.exit(0);
}

if (!filePath) process.exit(0);

// Only track files in the CURRENT session's working directory (Bash targets are
// already absolutized to cwd above). Prevents edits in project A from triggering
// review when working in project B.
if (toolName !== 'Bash' && !filePath.startsWith(sessionCwd)) process.exit(0);

// Never-track: pure docs, secrets, VCS meta, dependency lockfiles, and our own
// internal state. Config/schema files (.json/.yaml/.yml/.sql/.toml) ARE tracked —
// a config/pipeline-driven feature is still a real change that needs review.
const name = basename(filePath).toLowerCase();
const skipExt = ['.md', '.txt', '.env'];
const skipExact = ['.gitignore', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];
if (skipExt.some(p => name.endsWith(p)) || skipExact.includes(name)) process.exit(0);
if (filePath.includes('.codeck/') || filePath.includes('.claude/')) process.exit(0);

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

let state = { files: [], count: 0, since: 0 };
try {
  if (existsSync(EDIT_TRACKER)) {
    state = JSON.parse(readFileSync(EDIT_TRACKER, 'utf-8'));
  }
} catch { /* start fresh */ }

// Add file if not already tracked
const shortPath = filePath.replace('/workspace/', '');
if (!state.files.includes(shortPath)) {
  state.files.push(shortPath);
  state.count = state.files.length;
  if (!state.since) state.since = Date.now();
}
// Advance lastEdit on EVERY edit (even re-edits of a tracked file) so a stale
// clean marker can't cover code changed after it — markers must post-date the diff.
state.lastEdit = Date.now();

writeFileSync(EDIT_TRACKER, JSON.stringify(state));
process.exit(0);
