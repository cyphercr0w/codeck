import { existsSync, readFileSync, mkdirSync, copyFileSync, rmSync } from 'fs';
import { scrypt, createHash, randomBytes, randomUUID, timingSafeEqual, ScryptOptions } from 'crypto';
import { join, dirname } from 'path';
import { atomicWriteFileSync } from './memory.js';
import { ACTIVE_AGENT } from './agent.js';

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

const CODECK_DIR = process.env.CODECK_DIR || '/workspace/.codeck';
const AUTH_FILE = join(CODECK_DIR, 'auth.json');

// Backup location on a volume that reliably persists (~/.claude)
const AUTH_BACKUP = join(ACTIVE_AGENT.configDir, 'codeck-auth.json');

// ============ IN-MEMORY AUTH STATE ============
// The in-memory config is the AUTHORITY while the server is running.
// Files are only for persistence across container restarts.
// This eliminates all issues with Docker Desktop WSL2 volume sync
// deleting files while the server is running.
let memoryAuthConfig: AuthConfig | null = null;

/** Write auth config to memory + all file locations (best-effort) */
function persistAuth(config: AuthConfig): void {
  memoryAuthConfig = config;
  const data = JSON.stringify(config, null, 2);

  // Write to primary file (best-effort)
  try {
    if (!existsSync(CODECK_DIR)) {
      mkdirSync(CODECK_DIR, { recursive: true, mode: 0o700 });
    }
    atomicWriteFileSync(AUTH_FILE, data, { mode: 0o600 });
  } catch (e) {
    console.warn('[Auth] Failed to write auth.json:', (e as Error).message);
  }

  // Write to backup (best-effort)
  try {
    const backupDir = dirname(AUTH_BACKUP);
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
    atomicWriteFileSync(AUTH_BACKUP, data, { mode: 0o600 });
  } catch (e) {
    console.warn('[Auth] Failed to write backup:', (e as Error).message);
  }
}

/** Load auth config from files into memory (startup only) */
function loadAuthFromDisk(): AuthConfig | null {
  // Try primary file
  try {
    if (existsSync(AUTH_FILE)) {
      const config = JSON.parse(readFileSync(AUTH_FILE, 'utf-8')) as AuthConfig;
      if (config.passwordHash && config.salt) {
        console.log('[Auth] Loaded auth config from auth.json');
        return config;
      }
    }
  } catch (e) {
    console.warn('[Auth] Error reading auth.json:', (e as Error).message);
  }

  // Try backup
  try {
    if (existsSync(AUTH_BACKUP)) {
      const config = JSON.parse(readFileSync(AUTH_BACKUP, 'utf-8')) as AuthConfig;
      if (config.passwordHash && config.salt) {
        console.log('[Auth] Loaded auth config from backup');
        // Restore primary file while we're at it
        try {
          if (!existsSync(CODECK_DIR)) mkdirSync(CODECK_DIR, { recursive: true, mode: 0o700 });
          copyFileSync(AUTH_BACKUP, AUTH_FILE);
        } catch { /* best-effort */ }
        return config;
      }
    }
  } catch (e) {
    console.warn('[Auth] Error reading backup:', (e as Error).message);
  }

  return null;
}

// Load on module init — this is the ONLY time we read from disk
memoryAuthConfig = loadAuthFromDisk();

// ============ SESSIONS ============

interface SessionData {
  id: string;        // UUID — used by the API for revocation (never expose token)
  createdAt: number;
  ip: string;
}

const SESSIONS_FILE = join(CODECK_DIR, 'sessions.json');
const activeSessions = new Map<string, SessionData>(); // token → data
const sessionById   = new Map<string, string>();        // id    → token (for O(1) revoke)
const SESSION_TTL = parseInt(process.env.SESSION_TTL_MS || '604800000', 10); // default 7 days

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
    // Non-fatal: sessions will work in-memory only
  }
}

function loadSessions(): void {
  try {
    if (!existsSync(SESSIONS_FILE)) return;
    const data: Record<string, any> = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    const now = Date.now();
    for (const [token, session] of Object.entries(data)) {
      if (now - session.createdAt <= SESSION_TTL) {
        const sessionData: SessionData = {
          id: session.id || randomUUID(),
          createdAt: session.createdAt,
          ip: session.ip || 'unknown',
        };
        activeSessions.set(token, sessionData);
        sessionById.set(sessionData.id, token);
      }
    }
  } catch {
    // Non-fatal: start with empty sessions
  }
}

// Load persisted sessions on startup
loadSessions();

// ============ AUTH EVENT LOG ============

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

// ============ AUTH CONFIG ============

interface AuthConfig {
  passwordHash: string;
  salt: string;
  algo?: 'scrypt' | 'sha256';  // old hashes lack this field (sha256), new ones have 'scrypt'
  scryptCost?: number;          // track cost so we can detect and rehash old-cost hashes
}

// OWASP minimum: N=2^17 (131072), r=8, p=1
// maxmem must be set explicitly — Node.js defaults to 32MB which is insufficient
// for cost=131072 (needs 128 * blockSize * cost = 128MB)
const SCRYPT_COST = 131072;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024; // 256MB

async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await scryptAsync(password, salt, 64, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAXMEM,
  });
  return key.toString('hex');
}

/**
 * Verify password with the cost parameter that was used when the hash was created.
 * Falls back to Node.js default (16384) for hashes created before cost was tracked.
 */
async function hashPasswordWithCost(password: string, salt: string, cost: number): Promise<string> {
  const key = await scryptAsync(password, salt, 64, {
    cost,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAXMEM,
  });
  return key.toString('hex');
}

/**
 * Legacy SHA-256 hash — only used to verify passwords created before the scrypt migration.
 */
function hashPasswordLegacy(password: string, salt: string): string {
  return createHash('sha256').update(salt + password).digest('hex');
}

// ============ PUBLIC API ============

export function isPasswordConfigured(): boolean {
  // In-memory state is authoritative — no filesystem checks needed
  return memoryAuthConfig !== null;
}

/** Reset in-memory auth state — ONLY for testing.
 * Reloads from disk. Also cleans up backup file to prevent cross-test leaks. */
export function _resetForTesting(): void {
  // Clean backup file too (persistAuth writes here)
  try { if (existsSync(AUTH_BACKUP)) rmSync(AUTH_BACKUP, { force: true }); } catch { /* ignore */ }
  memoryAuthConfig = loadAuthFromDisk();
}

export async function setupPassword(password: string, ip = 'unknown'): Promise<{ success: boolean; token: string }> {
  const salt = randomBytes(32).toString('hex');
  const config: AuthConfig = {
    passwordHash: await hashPassword(password, salt),
    salt,
    algo: 'scrypt',
    scryptCost: SCRYPT_COST,
  };

  persistAuth(config);

  // Create session automatically
  const token = randomBytes(32).toString('hex');
  const sessionData: SessionData = { id: randomUUID(), createdAt: Date.now(), ip };
  activeSessions.set(token, sessionData);
  sessionById.set(sessionData.id, token);
  saveSessions();
  return { success: true, token };
}

export async function validatePassword(password: string, ip = 'unknown'): Promise<{ success: boolean; token?: string }> {
  if (!memoryAuthConfig) return { success: false };

  try {
    const config = memoryAuthConfig;

    // Determine which algorithm was used
    const isLegacy = config.algo !== 'scrypt';
    const storedCost = config.scryptCost || 16384; // Node.js default for pre-upgrade hashes
    const hash = isLegacy
      ? hashPasswordLegacy(password, config.salt)
      : await hashPasswordWithCost(password, config.salt, storedCost);

    // Timing-safe comparison
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(config.passwordHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      logAuthEvent('login_failure', ip);
      return { success: false };
    }

    // Opportunistic rehash: upgrade legacy (SHA-256) or old-cost scrypt hashes
    if (isLegacy || storedCost < SCRYPT_COST) {
      const newSalt = randomBytes(32).toString('hex');
      const upgraded: AuthConfig = {
        passwordHash: await hashPassword(password, newSalt),
        salt: newSalt,
        algo: 'scrypt',
        scryptCost: SCRYPT_COST,
      };
      persistAuth(upgraded);
      const reason = isLegacy ? 'SHA-256 to scrypt' : `scrypt cost ${storedCost} to ${SCRYPT_COST}`;
      console.log(`[Auth] Migrated password hash: ${reason}`);
    }

    const token = randomBytes(32).toString('hex');
    const sessionData: SessionData = { id: randomUUID(), createdAt: Date.now(), ip };
    activeSessions.set(token, sessionData);
    sessionById.set(sessionData.id, token);
    saveSessions();
    logAuthEvent('login_success', ip);
    return { success: true, token };
  } catch {
    return { success: false };
  }
}

export function validateSession(token: string): boolean {
  const session = activeSessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    activeSessions.delete(token);
    saveSessions();
    return false;
  }
  return true;
}

export function invalidateSession(token: string): void {
  const session = activeSessions.get(token);
  if (session) sessionById.delete(session.id);
  activeSessions.delete(token);
  saveSessions();
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string; token?: string }> {
  if (!memoryAuthConfig) return { success: false, error: 'Password not configured' };

  // Verify current password (reuses validatePassword logic without creating a session)
  const verification = await validatePassword(currentPassword);
  if (!verification.success) return { success: false, error: 'Current password is incorrect' };

  // Hash new password with current OWASP-compliant parameters
  const salt = randomBytes(32).toString('hex');
  const config: AuthConfig = {
    passwordHash: await hashPassword(newPassword, salt),
    salt,
    algo: 'scrypt',
    scryptCost: SCRYPT_COST,
  };
  persistAuth(config);

  // Invalidate all existing sessions (force re-login)
  activeSessions.clear();
  sessionById.clear();
  saveSessions();

  // Create a new session for the current user
  const token = randomBytes(32).toString('hex');
  const sessionData: SessionData = { id: randomUUID(), createdAt: Date.now(), ip: 'unknown' };
  activeSessions.set(token, sessionData);
  sessionById.set(sessionData.id, token);
  saveSessions();

  console.log('[Auth] Password changed successfully');
  return { success: true, token };
}

// ============ SESSION / LOG QUERIES ============

export interface SessionInfo {
  id: string;
  createdAt: number;
  expiresAt: number;
  ip: string;
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
      current: token === currentToken,
    });
  }
  return results.sort((a, b) => b.createdAt - a.createdAt);
}

export function revokeSessionById(sessionId: string): boolean {
  const token = sessionById.get(sessionId);
  if (!token) return false;
  invalidateSession(token);
  return true;
}

export function getAuthLog(): AuthLogEntry[] {
  return [...authLog];
}
