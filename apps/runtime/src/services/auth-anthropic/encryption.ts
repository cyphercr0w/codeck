/**
 * Encryption/decryption utilities for OAuth credential storage.
 * Uses AES-256-GCM with a derived key from scrypt.
 */
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import { join } from 'path';
import { atomicWriteFileSync } from '../memory.js';

// ============ Constants ============

export const CODECK_DIR = process.env.CODECK_DIR || '/workspace/.codeck';
export const AUTO_KEY_PATH = join(CODECK_DIR, '.encryption-key');

const ENCRYPTION_SALT = 'codeck-credential-encryption-v1';

// ============ Types ============

export interface EncryptedValue {
  encrypted: string;
  iv: string;
  tag: string;
}

export interface EncryptedCredentials {
  version: 2;
  claudeAiOauth: {
    accessToken: EncryptedValue;
    refreshToken: EncryptedValue;
    expiresAt: number;
  };
  accountInfo?: AccountInfo;
}

export interface PlaintextCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
  };
  accountInfo?: AccountInfo;
}

/**
 * Scopes granted by the OAuth PKCE flow. Claude CLI >= 2.1.241 rejects a
 * .credentials.json without this field ("Not logged in"), so every write must
 * include it. Mirrors OAUTH_SCOPE in auth-anthropic.ts.
 */
export const OAUTH_SCOPES = ['user:inference', 'user:profile'];

export interface AccountInfo {
  email: string | null;
  accountUuid: string | null;
  organizationName: string | null;
  organizationUuid: string | null;
}

// ============ Key Derivation ============

/**
 * Derive an encryption key from a stable source.
 * Priority: CODECK_ENCRYPTION_KEY env var > auto-generated persisted key > hostname fallback.
 * Result is cached — scryptSync is CPU-intensive and blocks the event loop.
 */
let _cachedEncryptionKey: Buffer | null = null;

export function deriveEncryptionKey(): Buffer {
  if (_cachedEncryptionKey) return _cachedEncryptionKey;

  let key: Buffer;
  if (process.env.CODECK_ENCRYPTION_KEY) {
    key = scryptSync(process.env.CODECK_ENCRYPTION_KEY, ENCRYPTION_SALT, 32);
  } else {
    // Auto-generate and persist a random key on first use
    try {
      if (!existsSync(AUTO_KEY_PATH)) {
        if (!existsSync(CODECK_DIR)) mkdirSync(CODECK_DIR, { recursive: true, mode: 0o700 });
        const randomKey = randomBytes(32).toString('hex');
        atomicWriteFileSync(AUTO_KEY_PATH, randomKey, { mode: 0o600 });
        console.log('[Security] Generated new encryption key at .codeck/.encryption-key');
      }
      const persistedKey = readFileSync(AUTO_KEY_PATH, 'utf8').trim();
      if (persistedKey.length >= 32) {
        key = scryptSync(persistedKey, ENCRYPTION_SALT, 32);
      } else {
        throw new Error('Key too short');
      }
    } catch (e) {
      console.warn('[Security] Could not read/write auto-generated encryption key:', (e as Error).message);
      // Final fallback: hostname-based (least secure)
      console.warn('[Security] Using hostname-based encryption key. Set CODECK_ENCRYPTION_KEY for production.');
      key = scryptSync(`codeck-${process.env.HOSTNAME || 'local'}-credential-key`, ENCRYPTION_SALT, 32);
    }
  }

  _cachedEncryptionKey = key;
  return key;
}

// ============ Encrypt / Decrypt ============

export function encryptValue(value: string): EncryptedValue {
  const key = deriveEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(value, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag();
  return { encrypted, iv: iv.toString('base64'), tag: tag.toString('base64') };
}

export function decryptValue(data: EncryptedValue): string {
  const key = deriveEncryptionKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
  let decrypted = decipher.update(data.encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
