import { createWriteStream, existsSync, mkdirSync, statSync } from 'fs';
import { readdir, stat, readFile } from 'fs/promises';
import { join } from 'path';
import { stripVTControlCharacters } from 'util';
import type { WriteStream } from 'fs';
import { PATHS } from './memory.js';

const MAX_TRANSCRIPT_SIZE = 50 * 1024 * 1024; // 50MB per session transcript

interface ActiveCapture {
  stream: WriteStream;
  path: string;
  inputBuffer: string;
  outputBuffer: string;
  outputTimer: ReturnType<typeof setTimeout> | null;
  inputTimer: ReturnType<typeof setTimeout> | null;
  lineCount: number;
  paused: boolean;
  sizeLimitReached: boolean;
}

const captures = new Map<string, ActiveCapture>();

// Strip ANSI escape sequences using Node.js built-in (covers CSI, OSC, and 8-bit sequences)
function stripAnsi(str: string): string {
  return stripVTControlCharacters(str);
}

// Sanitize secrets/tokens before logging
// Matches common token patterns: Bearer tokens, API keys, OAuth tokens, JWTs, hex secrets
export function sanitizeSecrets(str: string): string {
  return str
    // Bearer tokens (case-insensitive)
    .replace(/(?:bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    // Key-value pairs: token=..., api_key="...", password: ...
    .replace(/(token|api[_-]?key|secret|password|auth|credential)[=:"'\s]+[A-Za-z0-9\-._~+/]{20,}/gi, '$1=[REDACTED]')
    // JWTs (eyJ header.payload.signature)
    .replace(/eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.+/=]*/g, '[JWT_REDACTED]')
    // Platform-specific key prefixes (GitHub, Stripe, npm, GitLab, Netlify, etc.)
    .replace(/(?:sk|pk|rk|ak|ghp|gho|ghr|ghs|ghu|github_pat|glpat|npm_|nps_|pypi-AgEIcH)[-_][A-Za-z0-9\-_]{16,}/g, '[KEY_REDACTED]')
    // Anthropic keys (sk-ant-...)
    .replace(/sk-ant-[A-Za-z0-9\-]{20,}/g, '[KEY_REDACTED]')
    // SendGrid keys (SG....)
    .replace(/SG\.[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}/g, '[KEY_REDACTED]')
    // DigitalOcean tokens (do_v1_...)
    .replace(/do_v1_[A-Fa-f0-9]{64}/g, '[KEY_REDACTED]')
    // HuggingFace tokens (hf_...)
    .replace(/hf_[A-Za-z0-9]{20,}/g, '[KEY_REDACTED]')
    // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-)
    .replace(/xox[bpar]-[A-Za-z0-9\-]{20,}/g, '[KEY_REDACTED]')
    // AWS access keys (AKIA...)
    .replace(/AKIA[A-Z0-9]{16}/g, '[AWS_KEY_REDACTED]')
    // AWS secret keys (often 40 chars base64-ish after key= or similar context)
    .replace(/(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)[=:"'\s]+[A-Za-z0-9/+=]{30,}/gi, '$1=[REDACTED]')
    // Database connection strings
    .replace(/:\/\/[^:]+:[^@]+@/g, '://[CREDENTIALS_REDACTED]@')
    // PEM private keys
    .replace(/-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g, '[PRIVATE_KEY_REDACTED]');
}

function writeLine(capture: ActiveCapture, obj: Record<string, unknown>): void {
  if (capture.sizeLimitReached) return;

  // Check file size every 100 lines
  if (capture.lineCount > 0 && capture.lineCount % 100 === 0) {
    try {
      const { size } = statSync(capture.path);
      if (size > MAX_TRANSCRIPT_SIZE) {
        capture.sizeLimitReached = true;
        capture.stream.write(JSON.stringify({ ts: Date.now(), role: 'system', event: 'size_limit_reached', maxBytes: MAX_TRANSCRIPT_SIZE }) + '\n');
        console.warn(`[SessionWriter] Transcript ${capture.path} exceeded ${MAX_TRANSCRIPT_SIZE} bytes, stopping capture`);
        return;
      }
    } catch { /* stat failure — continue writing */ }
  }

  const ok = capture.stream.write(JSON.stringify(obj) + '\n');
  capture.lineCount++;

  // Backpressure: pause further writes until stream drains
  if (!ok) {
    capture.paused = true;
    capture.stream.once('drain', () => { capture.paused = false; });
  }
}

export function startSessionCapture(id: string, cwd: string): void {
  if (!existsSync(PATHS.SESSIONS_DIR)) {
    mkdirSync(PATHS.SESSIONS_DIR, { recursive: true });
  }

  const filename = `${id}.jsonl`;
  const filepath = join(PATHS.SESSIONS_DIR, filename);
  const stream = createWriteStream(filepath, { flags: 'a' });

  stream.on('error', (err) => {
    console.error(`[SessionWriter] Write error for ${id}: ${err.message}`);
    captures.delete(id);
  });

  const capture: ActiveCapture = {
    stream,
    path: filepath,
    inputBuffer: '',
    outputBuffer: '',
    outputTimer: null,
    inputTimer: null,
    lineCount: 0,
    paused: false,
    sizeLimitReached: false,
  };

  captures.set(id, capture);

  writeLine(capture, {
    ts: Date.now(),
    role: 'system',
    event: 'start',
    cwd,
  });

  console.log(`[SessionWriter] Started capture for ${id}`);
}

export function captureInput(id: string, data: string): void {
  const capture = captures.get(id);
  if (!capture || capture.paused || capture.sizeLimitReached) return;

  capture.inputBuffer += data;

  // Flush on newline
  if (capture.inputBuffer.includes('\n') || capture.inputBuffer.includes('\r')) {
    flushInput(capture);
    return;
  }

  // Debounce: flush after 2s of no input
  if (capture.inputTimer) clearTimeout(capture.inputTimer);
  capture.inputTimer = setTimeout(() => flushInput(capture), 2000);
}

function flushInput(capture: ActiveCapture): void {
  if (capture.inputTimer) {
    clearTimeout(capture.inputTimer);
    capture.inputTimer = null;
  }
  if (!capture.inputBuffer) return;

  const clean = sanitizeSecrets(stripAnsi(capture.inputBuffer).trim());
  if (clean) {
    writeLine(capture, {
      ts: Date.now(),
      role: 'input',
      data: clean,
    });
  }
  capture.inputBuffer = '';
}

// Compaction detection patterns
const COMPACTION_PATTERNS = [
  /auto-compact/i,
  /context.*compact/i,
  /summariz.*context/i,
  /compacting.*conversation/i,
  /context.*window.*full/i,
];

let compactionCallback: ((sessionId: string) => void) | null = null;

export function onCompactionDetected(cb: (sessionId: string) => void): void {
  compactionCallback = cb;
}

export function captureOutput(id: string, data: string): void {
  const capture = captures.get(id);
  if (!capture || capture.sizeLimitReached) return;

  capture.outputBuffer += data;

  // Check for compaction patterns in raw output
  const clean = stripAnsi(data);
  for (const pattern of COMPACTION_PATTERNS) {
    if (pattern.test(clean)) {
      writeLine(capture, {
        ts: Date.now(),
        role: 'system',
        event: 'compaction_detected',
        pattern: pattern.source,
      });
      console.log(`[SessionWriter] Compaction detected in session ${id}`);
      if (compactionCallback) compactionCallback(id);
      break;
    }
  }

  // Flush every 500ms or 2KB
  if (capture.outputBuffer.length >= 2048) {
    flushOutput(capture);
    return;
  }

  if (capture.outputTimer) clearTimeout(capture.outputTimer);
  capture.outputTimer = setTimeout(() => flushOutput(capture), 500);
}

function flushOutput(capture: ActiveCapture): void {
  if (capture.outputTimer) {
    clearTimeout(capture.outputTimer);
    capture.outputTimer = null;
  }
  if (!capture.outputBuffer) return;

  const clean = sanitizeSecrets(stripAnsi(capture.outputBuffer));
  if (clean.trim()) {
    writeLine(capture, {
      ts: Date.now(),
      role: 'output',
      data: clean,
    });
  }
  capture.outputBuffer = '';
}

export function endSessionCapture(id: string): void {
  const capture = captures.get(id);
  if (!capture) return;

  // Flush remaining buffers
  flushInput(capture);
  flushOutput(capture);

  writeLine(capture, {
    ts: Date.now(),
    role: 'system',
    event: 'end',
    lines: capture.lineCount,
  });

  capture.stream.end();
  captures.delete(id);

  console.log(`[SessionWriter] Ended capture for ${id} (${capture.lineCount} lines)`);
}

// ── Session listing/reading for API ──

export async function listSessionFiles(): Promise<{ id: string; size: number; createdAt: number }[]> {
  if (!existsSync(PATHS.SESSIONS_DIR)) return [];
  const files = await readdir(PATHS.SESSIONS_DIR);
  const results: { id: string; size: number; createdAt: number }[] = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const s = await stat(join(PATHS.SESSIONS_DIR, f));
    results.push({
      id: f.replace('.jsonl', ''),
      size: s.size,
      createdAt: s.birthtimeMs || s.ctimeMs,
    });
  }
  return results.sort((a, b) => b.createdAt - a.createdAt);
}

export async function readSessionTranscript(id: string): Promise<{ exists: boolean; lines: string[] | null }> {
  const safeId = id.replace(/[^a-zA-Z0-9_\-]/g, '');
  const filePath = join(PATHS.SESSIONS_DIR, `${safeId}.jsonl`);
  if (!existsSync(filePath)) return { exists: false, lines: null };
  const content = await readFile(filePath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  return { exists: true, lines };
}

export async function getSessionSummary(id: string): Promise<{ exists: boolean; summary: Record<string, unknown> | null }> {
  const safeId = id.replace(/[^a-zA-Z0-9_\-]/g, '');
  const filePath = join(PATHS.SESSIONS_DIR, `${safeId}.jsonl`);
  if (!existsSync(filePath)) return { exists: false, summary: null };

  const content = await readFile(filePath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  let startTs = 0;
  let endTs = 0;
  let cwd = '';
  const lineCount = lines.length;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.role === 'system' && obj.event === 'start') {
        startTs = obj.ts;
        cwd = obj.cwd || '';
      }
      if (obj.role === 'system' && obj.event === 'end') {
        endTs = obj.ts;
      }
    } catch { /* skip malformed lines */ }
  }

  return {
    exists: true,
    summary: {
      id: safeId,
      cwd,
      startTs,
      endTs,
      duration: endTs && startTs ? endTs - startTs : null,
      lines: lineCount,
    },
  };
}
