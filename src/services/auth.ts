import { existsSync, readFileSync, mkdirSync } from 'fs';
import { scrypt, createHash, randomBytes, timingSafeEqual, ScryptOptions } from 'crypto';
import { join } from 'path';
import { atomicWriteFileSync } from './memory.js';

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

const SESSIONS_FILE = join(CODECK_DIR, 'sessions.json');
const activeSessions = new Map<string, { createdAt: number }>();
const SESSION_TTL = parseInt(process.env.SESSION_TTL_MS || '604800000', 10); // default 7 days

function saveSessions(): void {
  try {
    const data: Record<string, { createdAt: number }> = {};
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
    const data: Record<string, { createdAt: number }> = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    const now = Date.now();
    for (const [token, session] of Object.entries(data)) {
      if (now - session.createdAt <= SESSION_TTL) {
        activeSessions.set(token, session);
      }
    }
  } catch {
    // Non-fatal: start with empty sessions
  }
}

// Load persisted sessions on startup
loadSessions();

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

export function isPasswordConfigured(): boolean {
  return existsSync(AUTH_FILE);
}

export async function setupPassword(password: string): Promise<{ success: boolean; token: string }> {
  if (!existsSync(CODECK_DIR)) {
    mkdirSync(CODECK_DIR, { recursive: true, mode: 0o700 });
  }

  const salt = randomBytes(32).toString('hex');
  const config: AuthConfig = {
    passwordHash: await hashPassword(password, salt),
    salt,
    algo: 'scrypt',
    scryptCost: SCRYPT_COST,
  };

  atomicWriteFileSync(AUTH_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });

  // Create session automatically
  const token = randomBytes(32).toString('hex');
  activeSessions.set(token, { createdAt: Date.now() });
  saveSessions();
  return { success: true, token };
}

export async function validatePassword(password: string): Promise<{ success: boolean; token?: string }> {
  if (!existsSync(AUTH_FILE)) return { success: false };

  try {
    const config: AuthConfig = JSON.parse(readFileSync(AUTH_FILE, 'utf-8'));

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
      atomicWriteFileSync(AUTH_FILE, JSON.stringify(upgraded, null, 2), { mode: 0o600 });
      const reason = isLegacy ? 'SHA-256 to scrypt' : `scrypt cost ${storedCost} to ${SCRYPT_COST}`;
      console.log(`[Auth] Migrated password hash: ${reason}`);
    }

    const token = randomBytes(32).toString('hex');
    activeSessions.set(token, { createdAt: Date.now() });
    saveSessions();
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
  activeSessions.delete(token);
  saveSessions();
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string; token?: string }> {
  if (!existsSync(AUTH_FILE)) return { success: false, error: 'Password not configured' };

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
  atomicWriteFileSync(AUTH_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });

  // Invalidate all existing sessions (force re-login)
  activeSessions.clear();
  saveSessions();

  // Create a new session for the current user
  const token = randomBytes(32).toString('hex');
  activeSessions.set(token, { createdAt: Date.now() });
  saveSessions();

  console.log('[Auth] Password changed successfully');
  return { success: true, token };
}
