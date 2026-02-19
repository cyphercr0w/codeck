import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { scrypt, randomBytes, randomUUID, timingSafeEqual, ScryptOptions } from 'crypto';
import { join, dirname } from 'path';
import { CODECK_DIR } from '../lib/paths.js';

// ── Helpers ──

function scryptAsync(password: string, salt: string, keylen: number, options?: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null, derivedKey: Buffer) => {
      if (err) reject(err);
      else resolve(derivedKey);
    };
    if (options) scrypt(password, salt, keylen, options, cb);
    else scrypt(password, salt, keylen, cb);
  });
}

function atomicWriteFileSync(filePath: string, data: string, options?: { mode?: number }): void {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmpPath, data, options);
    renameSync(tmpPath, filePath);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup failure */ }
    throw e;
  }
}

// ── Config ──

const AUTH_FILE = join(CODECK_DIR, 'auth.json');
const SESSIONS_FILE = join(CODECK_DIR, 'daemon-sessions.json');

// ── Auth Config (shared with runtime — same password) ──

interface AuthConfig {
  passwordHash: string;
  salt: string;
  algo?: 'scrypt' | 'sha256';
  scryptCost?: number;
}

// Scrypt parameters — must match runtime
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

function loadAuthConfig(): AuthConfig | null {
  try {
    if (existsSync(AUTH_FILE)) {
      const config = JSON.parse(readFileSync(AUTH_FILE, 'utf-8')) as AuthConfig;
      if (config.passwordHash && config.salt) return config;
    }
  } catch (e) {
    console.warn('[Daemon/Auth] Error reading auth.json:', (e as Error).message);
  }
  return null;
}

export function isPasswordConfigured(): boolean {
  return loadAuthConfig() !== null;
}

// ── Sessions ──

export interface SessionData {
  id: string;
  createdAt: number;
  ip: string;
  deviceId: string;
  lastSeen: number;
}

const activeSessions = new Map<string, SessionData>(); // token → data
const sessionById = new Map<string, string>();          // id → token
const SESSION_TTL = parseInt(process.env.SESSION_TTL_MS || '604800000', 10); // 7 days

function saveSessions(): void {
  try {
    const data: Record<string, SessionData> = {};
    for (const [token, session] of activeSessions) {
      data[token] = session;
    }
    if (!existsSync(CODECK_DIR)) {
      mkdirSync(CODECK_DIR, { recursive: true, mode: 0o700 });
    }
    atomicWriteFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    // Non-fatal: sessions work in-memory only
  }
}

function loadSessions(): void {
  try {
    if (!existsSync(SESSIONS_FILE)) return;
    const data: Record<string, SessionData> = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    const now = Date.now();
    for (const [token, session] of Object.entries(data)) {
      if (now - session.createdAt <= SESSION_TTL) {
        const sessionData: SessionData = {
          id: session.id || randomUUID(),
          createdAt: session.createdAt,
          ip: session.ip || 'unknown',
          deviceId: session.deviceId || 'unknown',
          lastSeen: session.lastSeen || session.createdAt,
        };
        activeSessions.set(token, sessionData);
        sessionById.set(sessionData.id, token);
      }
    }
    if (activeSessions.size > 0) {
      console.log(`[Daemon/Auth] Restored ${activeSessions.size} session(s)`);
    }
  } catch {
    // Non-fatal: start with empty sessions
  }
}

// Load persisted sessions on startup
loadSessions();

// ── Auth Event Log ──

export interface AuthLogEntry {
  type: 'login_success' | 'login_failure';
  ip: string;
  timestamp: number;
}

const authLog: AuthLogEntry[] = [];
const MAX_AUTH_LOG = 200;

function logAuthEvent(type: AuthLogEntry['type'], ip: string): void {
  authLog.push({ type, ip, timestamp: Date.now() });
  if (authLog.length > MAX_AUTH_LOG) authLog.shift();
}

// ── Password Validation ──

async function verifyPassword(password: string, config: AuthConfig): Promise<boolean> {
  const isLegacy = config.algo !== 'scrypt';
  if (isLegacy) {
    // Legacy SHA-256 — daemon doesn't upgrade, that's runtime's job
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(config.salt + password).digest('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(config.passwordHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  const cost = config.scryptCost || 16384;
  const key = await scryptAsync(password, config.salt, 64, {
    cost,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAXMEM,
  });
  const hash = key.toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(config.passwordHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Public API ──

export async function validatePassword(
  password: string,
  ip: string,
  deviceId: string,
): Promise<{ success: boolean; token?: string; sessionId?: string; deviceId?: string }> {
  const config = loadAuthConfig();
  if (!config) return { success: false };

  try {
    const valid = await verifyPassword(password, config);
    if (!valid) {
      logAuthEvent('login_failure', ip);
      return { success: false };
    }

    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const sessionData: SessionData = {
      id: randomUUID(),
      createdAt: now,
      ip,
      deviceId,
      lastSeen: now,
    };
    activeSessions.set(token, sessionData);
    sessionById.set(sessionData.id, token);
    saveSessions();
    logAuthEvent('login_success', ip);
    return { success: true, token, sessionId: sessionData.id, deviceId: sessionData.deviceId };
  } catch {
    return { success: false };
  }
}

export function validateSession(token: string): boolean {
  const session = activeSessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessionById.delete(session.id);
    activeSessions.delete(token);
    saveSessions();
    return false;
  }
  return true;
}

export function touchSession(token: string): void {
  const session = activeSessions.get(token);
  if (session) {
    session.lastSeen = Date.now();
    // Debounce persistence — save at most every 60s
    if (!touchTimer) {
      touchTimer = setTimeout(() => {
        touchTimer = null;
        saveSessions();
      }, 60_000);
      // Don't keep process alive just for this timer
      touchTimer.unref();
    }
  }
}
let touchTimer: ReturnType<typeof setTimeout> | null = null;

export function invalidateSession(token: string): void {
  const session = activeSessions.get(token);
  if (session) sessionById.delete(session.id);
  activeSessions.delete(token);
  saveSessions();
}

// ── Session / Log Queries ──

export interface SessionInfo {
  id: string;
  createdAt: number;
  expiresAt: number;
  ip: string;
  deviceId: string;
  lastSeen: number;
  current: boolean;
}

export function getActiveSessions(currentToken?: string): SessionInfo[] {
  const now = Date.now();
  const results: SessionInfo[] = [];
  for (const [token, session] of activeSessions) {
    if (now - session.createdAt > SESSION_TTL) continue;
    results.push({
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.createdAt + SESSION_TTL,
      ip: session.ip,
      deviceId: session.deviceId,
      lastSeen: session.lastSeen,
      current: token === currentToken,
    });
  }
  return results.sort((a, b) => b.lastSeen - a.lastSeen);
}

export function revokeSessionById(sessionId: string): boolean {
  const token = sessionById.get(sessionId);
  if (!token) return false;
  invalidateSession(token);
  return true;
}

export function getSessionByToken(token: string): SessionData | undefined {
  return activeSessions.get(token);
}

export function getSessionById(sessionId: string): SessionData | undefined {
  const token = sessionById.get(sessionId);
  if (!token) return undefined;
  return activeSessions.get(token);
}

export function getAuthLog(): AuthLogEntry[] {
  return [...authLog];
}
