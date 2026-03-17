#!/usr/bin/env node
/**
 * Codeck Memory Stop Hook
 *
 * Fires when a Claude Code session ends. Reads the session transcript,
 * calls Claude Haiku to generate a semantic summary, and appends it
 * to the daily memory log.
 *
 * Configured in /root/.claude/settings.json under hooks.Stop
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const WORKSPACE = '/workspace';
const MEMORY_DIR = join(WORKSPACE, '.codeck/memory/daily');
const PATHS_DIR = join(WORKSPACE, '.codeck/memory/paths');

/** Compute path-scoped ID — mirrors resolvePathId() in memory.ts */
function computePathId(absPath) {
  return createHash('sha256').update(absPath).digest('hex').slice(0, 12);
}
const SESSIONS_DIR = join(WORKSPACE, '.codeck/sessions');
const API_URL = 'https://api.anthropic.com/v1/messages';

const MAX_TRANSCRIPT_CHARS = 12000; // Keep Haiku prompt small
const MIN_SESSION_LINES = 5;

async function main() {
  // Read hook payload from stdin
  let payload;
  try {
    const stdin = readFileSync('/dev/stdin', 'utf-8');
    payload = JSON.parse(stdin);
  } catch {
    process.exit(0); // Non-fatal — never block session close
  }

  const sessionId = payload?.session_id;
  if (!sessionId) process.exit(0);

  // Get OAuth token — read from disk (env var may not be set)
  let token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    // Try plaintext cache first, then credentials file
    const tokenCachePath = join(process.env.HOME || '/root', '.claude', '.codeck-oauth-token');
    const credentialsPath = join(process.env.HOME || '/root', '.claude', '.credentials.json');
    try {
      if (existsSync(tokenCachePath)) {
        token = readFileSync(tokenCachePath, 'utf-8').trim();
      } else if (existsSync(credentialsPath)) {
        const creds = JSON.parse(readFileSync(credentialsPath, 'utf-8'));
        token = creds?.claudeAiOauth?.accessToken;
      }
    } catch { /* non-fatal */ }
  }
  if (!token) process.exit(0);

  // Read transcript
  const transcriptPath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
  if (!existsSync(transcriptPath)) process.exit(0);

  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
  } catch {
    process.exit(0);
  }

  if (lines.length < MIN_SESSION_LINES) process.exit(0);

  // Extract cwd and meaningful content from transcript
  let cwd = '';
  const userMessages = [];
  const assistantMessages = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.role === 'system' && obj.event === 'start') cwd = obj.cwd || '';
      if (obj.role === 'input' && obj.data?.trim().length > 2) {
        userMessages.push(obj.data.trim().slice(0, 300));
      }
      if (obj.role === 'output' && obj.data?.trim().length > 10) {
        // Strip ANSI escapes
        const clean = obj.data
          .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
          .replace(/\x1b\][^\x07]*\x07/g, '')
          .replace(/\r/g, ' ')
          .trim();
        if (clean.length > 10) assistantMessages.push(clean.slice(0, 500));
      }
    } catch { /* skip malformed lines */ }
  }

  if (userMessages.length === 0) process.exit(0);

  const project = cwd.split('/').pop() || 'workspace';

  // Build a compact transcript digest for Haiku
  const transcriptDigest = [
    `Project: ${project} (${cwd})`,
    '',
    'User messages:',
    ...userMessages.slice(0, 10).map((m, i) => `${i + 1}. ${m}`),
    '',
    'Key assistant responses (excerpts):',
    ...assistantMessages.slice(0, 5).map((m, i) => `${i + 1}. ${m.slice(0, 300)}`),
  ].join('\n').slice(0, MAX_TRANSCRIPT_CHARS);

  // Call Claude Haiku for semantic summary
  let summary;
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': token,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: `You are a memory system for an AI agent named Claude running inside Codeck (a developer sandbox).

Analyze this session transcript and write a concise memory entry in Spanish (the user communicates in Spanish). Focus on:
- Decisions made (technical or product)
- Problems identified and solutions found
- New information or context established
- Next steps discussed

Be specific and useful. Skip small talk. Format as bullet points under clear headers. Max 400 words.

TRANSCRIPT:
${transcriptDigest}`,
        }],
      }),
    });

    if (!response.ok) process.exit(0);

    const data = await response.json();
    summary = data?.content?.[0]?.text;
  } catch {
    process.exit(0);
  }

  if (!summary?.trim()) process.exit(0);

  // Append to daily memory log
  const today = new Date().toISOString().slice(0, 10);
  const time = new Date().toTimeString().slice(0, 8);
  const entry = `\n### ${time} [${project}] #semantic-summary\n\n${summary.trim()}\n`;

  try {
    // 1. Write to global daily
    mkdirSync(MEMORY_DIR, { recursive: true });
    const dailyPath = join(MEMORY_DIR, `${today}.md`);
    const header = existsSync(dailyPath) ? '' : `# Daily — ${today}\n`;
    appendFileSync(dailyPath, header + entry);

    // 2. Also write to path-scoped daily (so injectContextIntoCLAUDEMd picks it up)
    if (cwd && cwd !== WORKSPACE) {
      const pathId = computePathId(cwd);
      const pathDailyDir = join(PATHS_DIR, pathId, 'daily');
      mkdirSync(pathDailyDir, { recursive: true });
      const pathDailyPath = join(pathDailyDir, `${today}.md`);
      const pathHeader = existsSync(pathDailyPath) ? '' : `# Daily — ${today} [${project}]\n`;
      appendFileSync(pathDailyPath, pathHeader + entry);
    }

    console.error(`[MemoryHook] Wrote semantic summary for session ${sessionId} (project: ${project})`);
  } catch {
    process.exit(0);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
