import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { CODECK_DIR } from '../lib/paths.js';

// ── Types ──

export type AuditEvent =
  | 'auth.login'
  | 'auth.login_failure'
  | 'auth.logout'
  | 'auth.session_revoked';

export interface AuditEntry {
  timestamp: string;    // ISO 8601
  event: AuditEvent;
  sessionId: string | null;
  deviceId: string | null;
  actor: string;        // IP address
  metadata?: Record<string, unknown>;
}

// ── Config ──

const AUDIT_FILE = join(CODECK_DIR, 'audit.log');

// ── Buffer for batched writes ──

let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 5_000; // flush every 5 seconds
const FLUSH_SIZE = 20;           // or when buffer reaches 20 entries

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

function flush(): void {
  if (buffer.length === 0) return;
  const lines = buffer.join('');
  buffer = [];
  try {
    const dir = dirname(AUDIT_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(AUDIT_FILE, lines, { mode: 0o600 });
  } catch (e) {
    console.warn('[Daemon/Audit] Failed to write audit.log:', (e as Error).message);
  }
}

// ── Public API ──

export function audit(
  event: AuditEvent,
  actor: string,
  opts?: {
    sessionId?: string | null;
    deviceId?: string | null;
    metadata?: Record<string, unknown>;
  },
): void {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    event,
    sessionId: opts?.sessionId ?? null,
    deviceId: opts?.deviceId ?? null,
    actor,
    metadata: opts?.metadata,
  };

  buffer.push(JSON.stringify(entry) + '\n');

  if (buffer.length >= FLUSH_SIZE) {
    flush();
  } else {
    scheduleFlush();
  }
}

/** Flush any buffered entries to disk. Call on shutdown. */
export function flushAudit(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flush();
}
