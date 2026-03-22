/**
 * Account info caching — survives CLI credential overwrites.
 * Stores account metadata (email, org) in a separate file so it persists
 * even when Claude CLI rewrites .credentials.json.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ACTIVE_AGENT } from '../agent.js';
import { atomicWriteFileSync } from '../memory.js';
import type { AccountInfo } from './encryption.js';

const CLAUDE_CONFIG_PATH = ACTIVE_AGENT.configDir;

export const ACCOUNT_INFO_CACHE_PATH = join(CLAUDE_CONFIG_PATH, '.codeck-account-info.json');

/** Save account info to a separate cache file (survives CLI credential overwrites) */
export function cacheAccountInfo(info: AccountInfo): void {
  try {
    atomicWriteFileSync(ACCOUNT_INFO_CACHE_PATH, JSON.stringify(info), { mode: 0o600 });
  } catch { /* non-fatal */ }
}

/** Read cached account info */
export function getCachedAccountInfo(): AccountInfo | null {
  try {
    if (!existsSync(ACCOUNT_INFO_CACHE_PATH)) return null;
    return JSON.parse(readFileSync(ACCOUNT_INFO_CACHE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}
