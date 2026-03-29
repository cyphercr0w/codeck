#!/usr/bin/env node
/**
 * PostToolUse Hook — Anticipatory Memory Pre-fetch
 *
 * Watches file operations (Read, Edit, Write) and pre-fetches related
 * memory context based on the file being worked on. Writes results to
 * a cache file that session-context-hook can include.
 *
 * This makes relevant context available BEFORE the agent explicitly searches.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import { execFileSync } from 'child_process';

const STATE_DIR = '/workspace/.codeck/state';
const CACHE_PATH = join(STATE_DIR, 'prefetch-cache.md');
const COOLDOWN_PATH = join(STATE_DIR, 'prefetch-cooldown.json');
const MEMORY_API = 'http://localhost/api/memory/search';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

// Only trigger on file operations
const tool = parsed.tool_name || '';
if (!['Read', 'Edit', 'Write'].includes(tool)) process.exit(0);

const filePath = parsed.tool_input?.file_path || parsed.tool_input?.path || '';
if (!filePath) process.exit(0);

// Cooldown: max once per 60 seconds to avoid hammering
try {
  if (existsSync(COOLDOWN_PATH)) {
    const cd = JSON.parse(readFileSync(COOLDOWN_PATH, 'utf-8'));
    if (Date.now() - cd.at < 60000) process.exit(0);
  }
} catch { /* proceed */ }

// Extract search terms from file path
const fileName = basename(filePath, '.ts').replace(/\.(tsx|js|jsx|mjs|css)$/, '');
const dirName = basename(dirname(filePath));
const terms = [fileName, dirName].filter(t => t && t.length > 2 && t !== 'src' && t !== 'components');
if (terms.length === 0) process.exit(0);

const query = terms.join(' ');

// Search memory API
let results = '';
try {
  const url = `${MEMORY_API}?q=${encodeURIComponent(query)}&limit=3`;
  const response = execFileSync('curl', ['-sf', url], { timeout: 3000 }).toString().trim();
  const data = JSON.parse(response);
  if (data.results && data.results.length > 0) {
    results = data.results
      .map(r => r.snippet || r.content || '')
      .filter(s => s.length > 20)
      .join('\n---\n')
      .slice(0, 2000); // cap at 2KB
  }
} catch { process.exit(0); } // API unavailable — silent fail

if (!results) process.exit(0);

// Write cache
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(CACHE_PATH, `<!-- prefetch for: ${query} -->\n${results}`);
writeFileSync(COOLDOWN_PATH, JSON.stringify({ at: Date.now(), query }));
