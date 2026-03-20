#!/usr/bin/env node

/**
 * Memory Consolidation Script — Sleep-time compute for Codeck.
 *
 * Reads recent daily logs, compares against durable memory, and writes
 * consolidation suggestions to pending-consolidation.md for human review.
 *
 * Designed to run as a SessionEnd hook or background cron.
 * Uses the Anthropic API directly with Haiku for cost efficiency (~$0.015/run).
 *
 * Strategies per entry (Agent-Zero pattern):
 *   SKIP          — redundant or low-value
 *   MERGE         — combine with existing entry
 *   REPLACE       — supersede outdated entry
 *   UPDATE        — add details to existing entry
 *   KEEP_SEPARATE — distinct new information
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

const MEMORY_DIR = '/workspace/.codeck/memory';
const DAILY_DIR = join(MEMORY_DIR, 'daily');
const DURABLE_PATH = join(MEMORY_DIR, 'MEMORY.md');
const PENDING_PATH = join(MEMORY_DIR, 'pending-consolidation.md');
const STATE_DIR = '/workspace/.codeck/state';
const LAST_RUN_PATH = join(STATE_DIR, 'last-consolidation.txt');

// Minimum hours between consolidation runs to avoid redundant processing
const MIN_INTERVAL_HOURS = 6;

// ── Check if we should run ──────────────────────────────────────

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

if (existsSync(LAST_RUN_PATH)) {
  const lastRun = parseInt(readFileSync(LAST_RUN_PATH, 'utf-8').trim(), 10);
  const hoursSince = (Date.now() - lastRun) / (1000 * 60 * 60);
  if (hoursSince < MIN_INTERVAL_HOURS) {
    process.exit(0); // Too soon, skip
  }
}

// ── Gather context ──────────────────────────────────────────────

// Read last 7 days of daily logs
const now = new Date();
const dailyEntries = [];
for (let i = 0; i < 7; i++) {
  const date = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
  const path = join(DAILY_DIR, `${date}.md`);
  if (existsSync(path)) {
    const content = readFileSync(path, 'utf-8').trim();
    if (content) {
      dailyEntries.push({ date, content: content.slice(-3000) }); // Last 3K chars per day
    }
  }
}

if (dailyEntries.length === 0) {
  writeFileSync(LAST_RUN_PATH, String(Date.now()));
  process.exit(0); // Nothing to consolidate
}

// Read current durable memory
const durableMemory = existsSync(DURABLE_PATH)
  ? readFileSync(DURABLE_PATH, 'utf-8').trim().slice(0, 3000)
  : '(empty)';

// ── Build consolidation prompt ──────────────────────────────────

const dailyText = dailyEntries
  .map(e => `### ${e.date}\n${e.content}`)
  .join('\n\n');

const prompt = `You are a memory consolidation agent. Your job is to analyze recent daily logs and suggest updates to durable memory.

## Current Durable Memory (MEMORY.md)
${durableMemory}

## Recent Daily Logs (last 7 days)
${dailyText}

## Instructions

For each piece of NEW information in the daily logs that is NOT already in durable memory:
1. Classify it: SKIP (ephemeral/redundant), MERGE (combine with existing), REPLACE (supersede outdated), UPDATE (add to existing), or KEEP_SEPARATE (new topic)
2. If not SKIP, write the suggested change

## Output Format

Write a markdown document with sections:

### Suggest Adding
- [new facts, patterns, or decisions worth preserving]

### Suggest Updating
- [existing entries that need refresh with new info]

### Suggest Removing
- [entries in MEMORY.md that are now outdated or superseded]

Rules:
- Each suggestion must be ONE atomic fact, not a paragraph
- Only suggest SIGNIFICANT information (decisions, patterns, bugs, preferences)
- Do NOT suggest adding ephemeral details (debug output, temporary fixes, exploration)
- Do NOT suggest adding anything already in MEMORY.md
- Daily logs now use crystallized format (atomic facts) — extract and promote the most durable ones
- If nothing significant to consolidate, just write "No changes needed."`;

// ── Call Haiku via Anthropic API ────────────────────────────────

const apiKey = process.env.ANTHROPIC_API_KEY;
const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

// Try to read OAuth token from credentials file if not in env
let token = apiKey || oauthToken;
if (!token) {
  try {
    const credsPath = join(process.env.CODECK_DIR || '/data/.codeck', 'auth.json');
    if (existsSync(credsPath)) {
      const creds = JSON.parse(readFileSync(credsPath, 'utf-8'));
      token = creds.claudeAiOauth?.accessToken;
    }
  } catch { /* non-fatal */ }
}

if (!token) {
  console.warn('[Consolidation] No API token available, skipping');
  process.exit(0);
}

try {
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };

  // Determine auth type
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  } else {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.warn(`[Consolidation] API error ${response.status}: ${err.slice(0, 200)}`);
    process.exit(0);
  }

  const data = await response.json();
  const result = data.content?.[0]?.text || 'No response';

  // ── Write pending consolidation ─────────────────────────────

  const header = `# Memory Consolidation — ${now.toISOString().slice(0, 10)}\n\n_Generated by sleep-time consolidation agent (Haiku). Review and apply manually._\n\n`;

  if (existsSync(PENDING_PATH)) {
    // Append to existing pending file
    appendFileSync(PENDING_PATH, `\n---\n\n${header}${result}\n`);
  } else {
    writeFileSync(PENDING_PATH, `${header}${result}\n`);
  }

  // Update last run timestamp
  writeFileSync(LAST_RUN_PATH, String(Date.now()));

  console.log(`[Consolidation] Suggestions written to ${PENDING_PATH}`);

} catch (e) {
  console.warn(`[Consolidation] Failed: ${e.message}`);
}
