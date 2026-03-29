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

const APPROVE = JSON.stringify({ result: "approve" });

let _approved = false;
function exitApprove() {
  if (!_approved) { _approved = true; process.stdout.write(APPROVE); }
  process.exit(0);
}

async function main() {
  // Read hook payload from stdin
  let payload;
  try {
    const stdin = readFileSync('/dev/stdin', 'utf-8');
    payload = JSON.parse(stdin);
  } catch {
    exitApprove();
  }

  const sessionId = payload?.session_id;
  if (!sessionId) exitApprove();

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
  if (!token) exitApprove();

  // Read transcript
  const transcriptPath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
  if (!existsSync(transcriptPath)) exitApprove();

  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
  } catch {
    exitApprove();
  }

  if (lines.length < MIN_SESSION_LINES) exitApprove();

  // Extract cwd and meaningful content from transcript
  let cwd = '';
  const userMessages = [];
  const assistantMessages = [];

  /** Strip ANSI escapes, control chars, and PTY noise from a string */
  function sanitize(raw) {
    return raw
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')   // ANSI CSI
      .replace(/\x1b\][^\x07]*\x07/g, '')       // OSC
      .replace(/\x1b\(B/g, '')                   // charset switch
      .replace(/\x1b./g, '')                     // other escapes
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '') // control chars (keep \n \r \t)
      .replace(/\r\n?/g, '\n')                   // normalize line endings
      .replace(/\n{3,}/g, '\n\n')                // collapse blank lines
      .trim();
  }

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.role === 'system' && obj.event === 'start') cwd = obj.cwd || '';
      if (obj.role === 'input' && obj.data?.trim().length > 2) {
        const clean = sanitize(obj.data);
        if (clean.length > 2) userMessages.push(clean.slice(0, 300));
      }
      if (obj.role === 'output' && obj.data?.trim().length > 10) {
        const clean = sanitize(obj.data);
        if (clean.length > 10) assistantMessages.push(clean.slice(0, 500));
      }
    } catch { /* skip malformed lines */ }
  }

  if (userMessages.length === 0) exitApprove();

  const project = cwd.split('/').pop() || 'workspace';

  // Build a compact transcript digest for Haiku
  const transcriptDigest = [
    `Project: ${project} (${cwd})`,
    `Session duration: ${lines.length} transcript lines`,
    '',
    'User messages:',
    ...userMessages.slice(0, 15).map((m, i) => `${i + 1}. ${m}`),
    '',
    'Key assistant responses (excerpts):',
    ...assistantMessages.slice(0, 8).map((m, i) => `${i + 1}. ${m.slice(0, 400)}`),
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
          content: `You are a crystallization engine for a developer sandbox called Codeck. Extract ATOMIC FACTS from this session transcript — discrete, searchable, independent pieces of knowledge.

Output format — one fact per line, categorized:

**Changes:**
- [file/feature]: what changed and why

**Decisions:**
- [topic]: what was decided and rationale

**Bugs:**
- [description]: root cause + fix status (fixed/pending)

**Corrections & Preferences:**
- [correction]: when the user said "no", "don't", "use X instead" — extract the rule they're teaching
- [preference]: coding style, workflow, communication preferences detected from behavior

**State:**
- [what]: current status (working/broken/in-progress)

**Next:**
- [task]: what's pending or planned

Rules:
- Each fact must be ONE independent statement, not a paragraph
- Include file names, function names, version numbers, error messages — be specific
- Skip greetings, small talk, typos, meta-conversation
- If the session was trivial, write "No significant activity."
- Max 25 facts. Quality over quantity.
- Write in English.

TRANSCRIPT:
${transcriptDigest}`,
        }],
      }),
    });

    if (!response.ok) exitApprove();

    const data = await response.json();
    summary = data?.content?.[0]?.text;
  } catch {
    exitApprove();
  }

  if (!summary?.trim()) exitApprove();

  // Append to daily memory log
  const today = new Date().toISOString().slice(0, 10);
  const time = new Date().toTimeString().slice(0, 8);
  const entry = `\n### ${time} [${project}] #crystallized\n\n${summary.trim()}\n`;

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
    exitApprove();
  }

  exitApprove();
}

main()
  .catch(() => exitApprove());
