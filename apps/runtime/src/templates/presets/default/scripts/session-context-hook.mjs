#!/usr/bin/env node
/**
 * UserPromptSubmit Hook — Session Context Injection
 *
 * KV-Cache optimization: injects dynamic memory context via hook instead of
 * mutating CLAUDE.md. This keeps CLAUDE.md 100% static so the inference engine
 * can reuse cached key-value tensors across sessions (~70%+ cache hit rate).
 *
 * Reads the sidecar file written by memory-context.ts and injects it as
 * additionalContext on the FIRST user message only (state.injected flag).
 * Subsequent messages skip this to avoid wasting tokens.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const STATE_DIR = '/workspace/.codeck/state';
const SIDECAR_PATH = join(STATE_DIR, 'session-context.md');
const INJECT_STATE = join(STATE_DIR, 'context-injected.json');

let input = '';
for await (const chunk of process.stdin) input += chunk;

// Check if already injected this session
try {
  if (existsSync(INJECT_STATE)) {
    const state = JSON.parse(readFileSync(INJECT_STATE, 'utf-8'));
    if (state.injected) process.exit(0); // already done
  }
} catch { /* proceed */ }

const SKILL_INDEX_PATH = join(STATE_DIR, 'skill-index.md');

// Read sidecar context (memory) — only inject project-memory section, skip durable-memory
// to save ~800 tokens per session. Durable memory is generic cross-project context;
// project-memory is already cwd-filtered and more relevant.
let memoryContext = '';
try {
  if (existsSync(SIDECAR_PATH)) {
    const raw = readFileSync(SIDECAR_PATH, 'utf-8').trim();
    // Extract only <project-memory>...</project-memory> section
    const pmMatch = raw.match(/<project-memory>([\s\S]*?)<\/project-memory>/);
    if (pmMatch) {
      memoryContext = `<project-memory>${pmMatch[1]}</project-memory>`;
    } else {
      // Fallback: if no project-memory section, use full content but truncate
      memoryContext = raw.slice(0, 3000);
    }
  }
} catch { /* non-fatal */ }

// Read skill index (progressive disclosure)
let skillIndex = '';
try {
  if (existsSync(SKILL_INDEX_PATH)) {
    skillIndex = readFileSync(SKILL_INDEX_PATH, 'utf-8').trim();
  }
} catch { /* non-fatal */ }

if (!memoryContext && !skillIndex) process.exit(0);

// Mark as injected
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(INJECT_STATE, JSON.stringify({ injected: true, at: Date.now() }));

// Build injection — memory + skill index
const parts = [];
if (memoryContext) parts.push(`<recent-memory>\n${memoryContext}\n</recent-memory>`);
if (skillIndex) parts.push(`<skill-index>\nThese skills are available via /learn <skill-id>. Only load a skill when you need it — read the index to find relevant ones first.\n\n${skillIndex}\n</skill-index>`);

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: parts.join('\n\n'),
  }
}));
