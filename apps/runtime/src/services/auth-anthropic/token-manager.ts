/**
 * Token cache, refresh, and file-watching logic.
 * Manages the plaintext token cache, background refresh monitor,
 * and the credentials file watcher that auto-restores deleted credentials.
 */
import { existsSync, readFileSync, chmodSync, statSync, unlinkSync, mkdirSync, watch } from 'fs';
import { join } from 'path';
import { ACTIVE_AGENT } from '../agent.js';
import { atomicWriteFileSync } from '../memory.js';
import {
  encryptValue,
  decryptValue,
  type EncryptedCredentials,
  type PlaintextCredentials,
  type AccountInfo,
} from './encryption.js';
import { cacheAccountInfo, getCachedAccountInfo, ACCOUNT_INFO_CACHE_PATH } from './account-cache.js';

// ============ Path Constants ============

const CLAUDE_CONFIG_PATH = ACTIVE_AGENT.configDir;
const CLAUDE_CREDENTIALS_PATH = ACTIVE_AGENT.credentialsFile;

// Backup location for OAuth credentials (same volume, different name to avoid CLI interference)
const CREDENTIALS_BACKUP = join(CLAUDE_CONFIG_PATH, '.codeck-credentials-backup.json');
// Plaintext token file that Claude CLI won't touch — used by getOAuthEnv as fallback
export const TOKEN_CACHE_PATH = join(CLAUDE_CONFIG_PATH, '.codeck-oauth-token');

// OAuth constants (from Claude CLI)
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

// ============ Module State ============

let authCache = { checked: false, authenticated: false, checkedAt: 0 };
export let tokenMarkedExpired = false;
// Set by logoutClaude() to prevent file watcher from re-syncing deleted credentials
export let loggedOut = false;
// Timestamp of the last successful token save — used to distinguish fresh logins from stale cache
let lastTokenSaveAt = 0;
const AUTH_CACHE_TTL = 5000;

// In-memory token — authoritative while server is running.
// File deletions (Docker WSL2 sync) cannot break auth once a token is loaded.
let inMemoryToken: string | null = null;
let inMemoryTokenExpiresAt = 0; // ms since epoch; 0 = unknown (treated as valid)

// Token refresh state
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes before expiry
let refreshInProgress = false;

// Background monitor state
const REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;      // Check every 5 minutes
const REFRESH_MARGIN_PROACTIVE_MS = 30 * 60 * 1000;   // Refresh 30 min before expiry
const REFRESH_WARN_MARGIN_MS = 60 * 60 * 1000;        // Warn user 60 min before expiry

let refreshMonitorInterval: ReturnType<typeof setInterval> | null = null;
let refreshMonitorBroadcast: ((data: unknown) => void) | null = null;

// ============ State Accessors ============

export function setTokenMarkedExpired(value: boolean): void {
  tokenMarkedExpired = value;
}

export function setLoggedOut(value: boolean): void {
  loggedOut = value;
}

export function getLastTokenSaveAt(): number {
  return lastTokenSaveAt;
}

/** Get the in-memory token (authoritative, survives file deletions). Returns null if expired. */
export function getInMemoryToken(): string | null {
  if (!inMemoryToken) return null;
  if (inMemoryTokenExpiresAt > 0 && Date.now() >= inMemoryTokenExpiresAt) return null;
  return inMemoryToken;
}

/** Get the in-memory token expiry timestamp (ms) */
export function getInMemoryTokenExpiresAt(): number {
  return inMemoryTokenExpiresAt;
}

/** Reset in-memory token — ONLY for testing */
export function _resetInMemoryTokenForTesting(): void {
  inMemoryToken = null;
  inMemoryTokenExpiresAt = 0;
}

export function getAuthCache(): { checked: boolean; authenticated: boolean; checkedAt: number } {
  return authCache;
}

export function setAuthCache(cache: { checked: boolean; authenticated: boolean; checkedAt: number }): void {
  authCache = cache;
}

export function getAuthCacheTTL(): number {
  return AUTH_CACHE_TTL;
}

export function getRefreshMonitorInterval(): ReturnType<typeof setInterval> | null {
  return refreshMonitorInterval;
}

// ============ Token Validation ============

/** Check if a token looks like a real OAuth token (not a mock/placeholder from CLI) */
export function isRealToken(token: string): boolean {
  // Real tokens are long (>50 chars). CLI writes "sk-ant-oat01-mock-access-token" (30 chars) as placeholder.
  return token.startsWith('sk-ant-oat01-') && token.length > 50;
}

// ============ Credentials Permissions ============

/**
 * Validate that credentials file has secure permissions (owner-only).
 * Returns false if file has insecure permissions (group/world readable).
 */
function validateCredentialsPermissions(): boolean {
  try {
    if (!existsSync(CLAUDE_CREDENTIALS_PATH)) return true; // no file = ok
    const stat = statSync(CLAUDE_CREDENTIALS_PATH);
    if ((stat.mode & 0o077) !== 0) {
      console.log('[Claude] ⚠ Credentials file has insecure permissions:', '0o' + (stat.mode & 0o777).toString(8));
      // Attempt to fix permissions
      chmodSync(CLAUDE_CREDENTIALS_PATH, 0o600);
      console.log('[Claude] ✓ Fixed credentials file permissions to 0o600');
    }
    return true;
  } catch (e) {
    console.log('[Claude] Error checking credentials permissions:', (e as Error).message);
    return false;
  }
}

// ============ Credential Backup / Restore ============

/** Backup credentials as encrypted AES-256-GCM to the backup file. */
export function backupCredentials(token: string, refreshToken: string, accountInfo: AccountInfo | undefined, expiresAt: number): void {
  try {
    const encrypted: EncryptedCredentials = {
      version: 2,
      claudeAiOauth: {
        accessToken: encryptValue(token),
        refreshToken: encryptValue(refreshToken),
        expiresAt,
      },
      accountInfo,
    };
    atomicWriteFileSync(CREDENTIALS_BACKUP, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn('[Claude] Failed to write encrypted credentials backup:', (e as Error).message);
  }
}

/** Restore credentials from encrypted backup, writing as plaintext for CLI compatibility. */
function restoreCredentials(): boolean {
  if (existsSync(CLAUDE_CREDENTIALS_PATH)) return false;
  if (!existsSync(CREDENTIALS_BACKUP)) return false;
  try {
    const raw = JSON.parse(readFileSync(CREDENTIALS_BACKUP, 'utf-8'));
    if (raw.version === 2 && raw.claudeAiOauth?.accessToken?.encrypted) {
      // Decrypt and write plaintext so the CLI can use it
      const token = decryptValue(raw.claudeAiOauth.accessToken);
      const refreshToken = raw.claudeAiOauth.refreshToken ? decryptValue(raw.claudeAiOauth.refreshToken) : '';
      const plain = {
        claudeAiOauth: {
          accessToken: token,
          ...(refreshToken ? { refreshToken } : {}),
          expiresAt: raw.claudeAiOauth.expiresAt,
        },
        ...(raw.accountInfo ? { accountInfo: raw.accountInfo } : {}),
      };
      atomicWriteFileSync(CLAUDE_CREDENTIALS_PATH, JSON.stringify(plain, null, 2), { mode: 0o600 });
      console.log('[Claude] Restored .credentials.json from encrypted backup (plaintext)');
      return true;
    }
    // Fallback: backup is already plaintext, copy as-is
    atomicWriteFileSync(CLAUDE_CREDENTIALS_PATH, readFileSync(CREDENTIALS_BACKUP, 'utf-8'), { mode: 0o600 });
    console.log('[Claude] Restored .credentials.json from backup');
    return true;
  } catch (e) {
    console.error('[Claude] Failed to restore credentials:', (e as Error).message);
    return false;
  }
}

// ============ Read Credentials ============

/** Read and decrypt the encrypted credentials backup. */
function readEncryptedBackup(): PlaintextCredentials | null {
  if (!existsSync(CREDENTIALS_BACKUP)) return null;
  try {
    const raw = JSON.parse(readFileSync(CREDENTIALS_BACKUP, 'utf-8'));
    if (raw.version === 2 && raw.claudeAiOauth?.accessToken?.encrypted) {
      const enc = raw as EncryptedCredentials;
      return {
        claudeAiOauth: {
          accessToken: decryptValue(enc.claudeAiOauth.accessToken),
          refreshToken: decryptValue(enc.claudeAiOauth.refreshToken),
          expiresAt: enc.claudeAiOauth.expiresAt,
        },
        accountInfo: enc.accountInfo,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read credentials. Primary source is the plaintext .credentials.json (CLI-compatible).
 * Falls back to the encrypted backup (.codeck-credentials-backup.json) if the primary is missing.
 * Also handles legacy v2 encrypted .credentials.json for backward compatibility.
 */
export function readCredentials(): PlaintextCredentials | null {
  // Ensure the primary file exists (restore from backup if missing)
  if (!existsSync(CLAUDE_CREDENTIALS_PATH)) {
    if (!restoreCredentials()) {
      // Last resort: try reading encrypted backup directly
      return readEncryptedBackup();
    }
  }
  validateCredentialsPermissions();

  try {
    const raw = JSON.parse(readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8'));

    // Legacy v2 encrypted format — decrypt on the fly (migration path)
    if (raw.version === 2 && raw.claudeAiOauth?.accessToken?.encrypted) {
      const enc = raw as EncryptedCredentials;
      return {
        claudeAiOauth: {
          accessToken: decryptValue(enc.claudeAiOauth.accessToken),
          refreshToken: decryptValue(enc.claudeAiOauth.refreshToken),
          expiresAt: enc.claudeAiOauth.expiresAt,
        },
        accountInfo: enc.accountInfo,
      };
    }

    // Plaintext format (our new primary format, also CLI-native)
    return raw as PlaintextCredentials;
  } catch (e) {
    console.log('[Claude] Error reading credentials, trying encrypted backup:', (e as Error).message);
    return readEncryptedBackup();
  }
}

// ============ Read Cached Token ============

/** Read cached plaintext OAuth token (fallback when .credentials.json is gone/corrupted) */
export function getCachedOAuthToken(): string | null {
  try {
    if (!existsSync(TOKEN_CACHE_PATH)) return null;
    const token = readFileSync(TOKEN_CACHE_PATH, 'utf-8').trim();
    return token.startsWith('sk-ant-oat01-') ? token : null;
  } catch {
    return null;
  }
}

// ============ Save Token ============

/**
 * Save OAuth token to credentials file.
 * Format required by Claude Code.
 */
export function saveOAuthToken(token: string, refreshToken = '', accountInfo?: AccountInfo, expiresIn?: number): boolean {
  if (!existsSync(CLAUDE_CONFIG_PATH)) {
    mkdirSync(CLAUDE_CONFIG_PATH, { recursive: true, mode: 0o700 });
  }

  // Use actual expires_in from OAuth response (seconds), fallback to 365 days
  const ttlMs = expiresIn ? expiresIn * 1000 : 365 * 24 * 60 * 60 * 1000;
  const expiresAt = Date.now() + ttlMs;

  // Write PLAINTEXT credentials in Claude CLI-compatible format.
  const plainCredentials: PlaintextCredentials = {
    claudeAiOauth: {
      accessToken: token,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt,
    },
    ...(accountInfo ? { accountInfo } : {}),
  };
  atomicWriteFileSync(CLAUDE_CREDENTIALS_PATH, JSON.stringify(plainCredentials, null, 2), { mode: 0o600 });

  // Write encrypted backup for security
  backupCredentials(token, refreshToken, accountInfo, expiresAt);

  // Save plaintext token cache (extra fallback)
  try {
    atomicWriteFileSync(TOKEN_CACHE_PATH, token, { mode: 0o600 });
  } catch { /* non-fatal */ }

  if (accountInfo) cacheAccountInfo(accountInfo);

  // Set in-memory token and expiry — authoritative while server runs
  inMemoryToken = token;
  inMemoryTokenExpiresAt = expiresAt;

  tokenMarkedExpired = false;
  loggedOut = false; // Clear logout flag — user has re-authenticated
  lastTokenSaveAt = Date.now();
  invalidateAuthCache();

  // Restart token refresh monitor if it was stopped (e.g., after logout)
  if (!refreshMonitorInterval) {
    startTokenRefreshMonitor(refreshMonitorBroadcast ?? undefined);
  }

  const expiresInHours = Math.round(ttlMs / 3600000);
  console.log(`[Claude] ✓ Token saved (plaintext + encrypted backup, expires in ${expiresInHours}h, refresh_token: ${refreshToken ? 'yes' : 'no'})`);
  return true;
}

// ============ Token Refresh ============

/**
 * Attempt to refresh the access token using the stored refresh token.
 */
export async function performTokenRefresh(refreshToken: string): Promise<boolean> {
  if (refreshInProgress) return false;
  refreshInProgress = true;

  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });

    if (!response.ok) {
      console.log('[Claude] Token refresh failed:', response.status);
      return false;
    }

    const tokenData = await response.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };

    if (tokenData.error || !tokenData.access_token) {
      console.log('[Claude] Token refresh error:', tokenData.error || 'no access_token');
      return false;
    }

    // Read existing credentials to preserve accountInfo
    const existing = readCredentials();
    const accountInfoVal = existing?.accountInfo;

    saveOAuthToken(tokenData.access_token, tokenData.refresh_token || refreshToken, accountInfoVal, tokenData.expires_in);
    tokenMarkedExpired = false;
    invalidateAuthCache();
    console.log('[Claude] ✓ Token refreshed successfully');
    return true;
  } catch (e) {
    console.log('[Claude] Token refresh exception:', (e as Error).message);
    return false;
  } finally {
    refreshInProgress = false;
  }
}

/**
 * Synchronously check if token needs refresh and trigger it if needed.
 * Returns false if token is expired and no refresh token is available.
 */
export function tryRefreshToken(creds: Record<string, unknown>): boolean {
  const oauth = creds.claudeAiOauth as { refreshToken?: string; expiresAt?: number } | undefined;
  if (!oauth?.refreshToken) {
    console.log('[Claude] No refresh token available');
    return false;
  }

  // Trigger async refresh in background
  performTokenRefresh(oauth.refreshToken);
  return false; // Return false so caller knows token is currently expired
}

/**
 * Schedule a proactive refresh if token is within the refresh margin.
 */
export function scheduleProactiveRefresh(creds: Record<string, unknown>): void {
  const oauth = creds.claudeAiOauth as { refreshToken?: string; expiresAt?: number } | undefined;
  if (!oauth?.refreshToken || !oauth?.expiresAt) return;

  const now = Date.now();
  const timeUntilExpiry = oauth.expiresAt - now;
  if (timeUntilExpiry > 0 && timeUntilExpiry <= REFRESH_MARGIN_MS) {
    console.log('[Claude] Token expires soon, triggering proactive refresh');
    performTokenRefresh(oauth.refreshToken);
  }
}

// ============ Auth Cache ============

export function invalidateAuthCache(): void {
  authCache = { checked: false, authenticated: false, checkedAt: 0 };
}

// ============ Clear Credentials ============

export function clearAllCredentialFiles(): void {
  try { if (existsSync(TOKEN_CACHE_PATH)) unlinkSync(TOKEN_CACHE_PATH); } catch { /* ignore */ }
  try { if (existsSync(CREDENTIALS_BACKUP)) unlinkSync(CREDENTIALS_BACKUP); } catch { /* ignore */ }
  try { if (existsSync(CLAUDE_CREDENTIALS_PATH)) unlinkSync(CLAUDE_CREDENTIALS_PATH); } catch { /* ignore */ }
  try { if (existsSync(ACCOUNT_INFO_CACHE_PATH)) unlinkSync(ACCOUNT_INFO_CACHE_PATH); } catch { /* ignore */ }
  console.log('[Claude] Cleared all cached credentials');
}

// ============ Mark Token Expired ============

/**
 * Mark the current token as expired (called when an API returns 401).
 * This forces isClaudeAuthenticated() to return false until a new login.
 */
export function markTokenExpired(): void {
  // Guard: if a token was saved very recently, this expiry signal is a stale PTY output
  const FRESH_TOKEN_GRACE_MS = 10_000;
  if (lastTokenSaveAt > 0 && Date.now() - lastTokenSaveAt < FRESH_TOKEN_GRACE_MS) {
    console.log('[Claude] markTokenExpired ignored — token was just saved (<10s ago), stale PTY signal discarded');
    return;
  }
  console.log('[Claude] ⚠ Token marked as expired (API returned 401)');
  tokenMarkedExpired = true;
  inMemoryToken = null;
  inMemoryTokenExpiresAt = 0;
  invalidateAuthCache();

  // Attempt recovery via refresh token BEFORE wiping files
  const creds = readCredentials();
  if (creds?.claudeAiOauth?.refreshToken) {
    console.log('[Claude] Attempting token refresh before clearing credentials...');
    performTokenRefresh(creds.claudeAiOauth.refreshToken).then(ok => {
      if (ok) {
        console.log('[Claude] Token recovered after 401');
      } else {
        console.log('[Claude] Refresh failed — clearing all credentials');
        clearAllCredentialFiles();
      }
    });
  } else {
    clearAllCredentialFiles();
  }
}

// ============ Sync After CLI ============

/**
 * After Claude CLI execution, check if CLI wrote a new valid token to .credentials.json.
 * Only update our cache if the token is real (not a mock placeholder).
 */
export function syncCredentialsAfterCLI(): void {
  try {
    if (!existsSync(CLAUDE_CREDENTIALS_PATH)) return;
    const raw = JSON.parse(readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8'));

    // Migration path: if an old v2 encrypted file still exists (upgrade from older Codeck),
    // decrypt it and rewrite as plaintext so the CLI can use it going forward.
    if (raw.version === 2 && raw.claudeAiOauth?.accessToken?.encrypted) {
      const token = decryptValue(raw.claudeAiOauth.accessToken);
      if (token && isRealToken(token)) {
        const refreshToken = raw.claudeAiOauth.refreshToken ? decryptValue(raw.claudeAiOauth.refreshToken) : '';
        const expiresAt: number = raw.claudeAiOauth.expiresAt ?? (Date.now() + 365 * 24 * 60 * 60 * 1000);
        const expiresInVal = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
        const accountInfoVal = raw.accountInfo ?? getCachedAccountInfo() ?? undefined;
        saveOAuthToken(token, refreshToken, accountInfoVal || undefined, expiresInVal);
        console.log('[Claude] Migrated v2 encrypted credentials to plaintext after CLI execution');
      }
      return;
    }

    // Plaintext format — the CLI may have refreshed the token and written back a new file.
    if (raw.claudeAiOauth?.accessToken && typeof raw.claudeAiOauth.accessToken === 'string') {
      const token = raw.claudeAiOauth.accessToken;
      if (!isRealToken(token)) {
        if (token.includes('mock')) console.log('[Claude] Ignoring mock token from CLI in .credentials.json');
        return;
      }
      if (token === inMemoryToken) return; // no change
      const refreshToken = typeof raw.claudeAiOauth?.refreshToken === 'string' ? raw.claudeAiOauth.refreshToken : '';
      const expiresAt: number = raw.claudeAiOauth?.expiresAt ?? 0;
      const expiresInVal = expiresAt > 0 ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000)) : undefined;
      const accountInfoVal = raw.accountInfo ?? getCachedAccountInfo() ?? undefined;
      saveOAuthToken(token, refreshToken, accountInfoVal || undefined, expiresInVal);
      console.log('[Claude] Synced updated credentials after CLI execution');
    }
  } catch (e) {
    console.warn('[Claude] syncCredentialsAfterCLI error:', (e as Error).message);
  }
}

// ============ Background Token Refresh Monitor ============

export function startTokenRefreshMonitor(broadcast?: (data: unknown) => void): void {
  if (refreshMonitorInterval) return; // Already running

  if (broadcast) refreshMonitorBroadcast = broadcast;
  console.log('[Claude] Starting token refresh monitor (every 5min, 30min proactive margin)');

  refreshMonitorInterval = setInterval(async () => {
    // Skip if token already marked expired
    if (tokenMarkedExpired) return;

    const creds = readCredentials();
    if (!creds?.claudeAiOauth?.expiresAt) return;

    const timeUntilExpiry = creds.claudeAiOauth.expiresAt - Date.now();
    const hasRefreshToken = !!creds.claudeAiOauth?.refreshToken?.trim();

    if (timeUntilExpiry <= 0) {
      // Already expired
      if (hasRefreshToken) {
        console.log('[Claude] Token expired, attempting recovery via refresh token...');
        const ok = await performTokenRefresh(creds.claudeAiOauth.refreshToken!);
        if (!ok) {
          console.log('[Claude] Refresh failed — token is dead, user must re-login');
          refreshMonitorBroadcast?.({ type: 'auth:expired' });
        }
      } else {
        console.log('[Claude] Token expired with no refresh token available — user must re-login');
        refreshMonitorBroadcast?.({ type: 'auth:expired' });
      }
    } else if (timeUntilExpiry <= REFRESH_MARGIN_PROACTIVE_MS) {
      // Expiring within 30 min — refresh proactively
      if (hasRefreshToken) {
        console.log(`[Claude] Token expires in ${Math.round(timeUntilExpiry / 60000)}min, refreshing proactively...`);
        const ok = await performTokenRefresh(creds.claudeAiOauth.refreshToken!);
        if (!ok) {
          console.log('[Claude] Proactive refresh failed — notifying frontend');
          refreshMonitorBroadcast?.({ type: 'auth:expiring', minutesLeft: Math.round(timeUntilExpiry / 60000) });
        }
      } else {
        console.log(`[Claude] Token expires in ${Math.round(timeUntilExpiry / 60000)}min, no refresh token — notifying frontend`);
        refreshMonitorBroadcast?.({ type: 'auth:expiring', minutesLeft: Math.round(timeUntilExpiry / 60000) });
      }
    } else if (timeUntilExpiry <= REFRESH_WARN_MARGIN_MS) {
      console.log(`[Claude] Token expires in ${Math.round(timeUntilExpiry / 60000)}min`);
    }
  }, REFRESH_CHECK_INTERVAL_MS);
}

export function stopTokenRefreshMonitor(): void {
  if (refreshMonitorInterval) {
    clearInterval(refreshMonitorInterval);
    refreshMonitorInterval = null;
  }
}

// ============ Module Initialization ============

// Restore credentials on module load
restoreCredentials();

// Watch for credentials file deletion and auto-restore (with debounce to avoid
// fighting with Claude CLI's own atomicWrite which causes transient rename events)
let credentialsRestoreTimer: ReturnType<typeof setTimeout> | null = null;
try {
  if (existsSync(CLAUDE_CONFIG_PATH)) {
    watch(CLAUDE_CONFIG_PATH, (eventType, filename) => {
      if (filename === '.credentials.json') {
        if (!existsSync(CLAUDE_CREDENTIALS_PATH)) {
          // Debounce: wait 500ms to see if it reappears (atomicWrite rename)
          if (credentialsRestoreTimer) clearTimeout(credentialsRestoreTimer);
          credentialsRestoreTimer = setTimeout(() => {
            if (!existsSync(CLAUDE_CREDENTIALS_PATH)) {
              console.log(`[Claude] WATCH: .credentials.json confirmed DELETED — ${new Date().toISOString()}`);
              if (existsSync(CREDENTIALS_BACKUP)) {
                try {
                  atomicWriteFileSync(CLAUDE_CREDENTIALS_PATH, readFileSync(CREDENTIALS_BACKUP, 'utf-8'), { mode: 0o600 });
                  console.log('[Claude] WATCH: auto-restored credentials from backup');
                } catch (e) {
                  console.error('[Claude] WATCH: auto-restore failed:', (e as Error).message);
                }
              }
            }
          }, 500);
        } else if (eventType === 'change' || eventType === 'rename') {
          // Skip if user explicitly logged out
          if (loggedOut) return;
          // File was rewritten — sync to in-memory state if it contains a valid token.
          try {
            const raw = JSON.parse(readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8'));
            // Plaintext format (CLI-native or our new format)
            if (raw.claudeAiOauth?.accessToken && typeof raw.claudeAiOauth.accessToken === 'string') {
              const token = raw.claudeAiOauth.accessToken;
              if (isRealToken(token) && token !== inMemoryToken) {
                const refreshToken = typeof raw.claudeAiOauth?.refreshToken === 'string' ? raw.claudeAiOauth.refreshToken : '';
                const expiresAt: number = raw.claudeAiOauth?.expiresAt ?? 0;
                console.log('[Claude] WATCH: CLI refreshed token — syncing to in-memory state');
                inMemoryToken = token;
                inMemoryTokenExpiresAt = expiresAt;
                tokenMarkedExpired = false;
                lastTokenSaveAt = Date.now();
                invalidateAuthCache();
                try { atomicWriteFileSync(TOKEN_CACHE_PATH, token, { mode: 0o600 }); } catch { /* non-fatal */ }
                const accountInfoVal = raw.accountInfo ?? getCachedAccountInfo() ?? undefined;
                backupCredentials(token, refreshToken, accountInfoVal, expiresAt);
              }
            }
          } catch { /* ignore — may be mid-write */ }
        }
      }
    });
  }
} catch (e) {
  console.warn('[Claude] Could not set up credentials watcher:', (e as Error).message);
}

// Eagerly populate in-memory token from disk at startup
try {
  const _creds = readCredentials();
  if (_creds?.claudeAiOauth?.accessToken && isRealToken(_creds.claudeAiOauth.accessToken)) {
    inMemoryToken = _creds.claudeAiOauth.accessToken;
    inMemoryTokenExpiresAt = _creds.claudeAiOauth.expiresAt || 0;
    console.log('[Claude] Auth pre-loaded from credentials file at startup');
  }
} catch { /* non-fatal — first WS connect will do a lazy read */ }
