import { execSync } from 'child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync, chmodSync, statSync, unlinkSync, copyFileSync, watch } from 'fs';
import { randomBytes, createHash, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import { join } from 'path';
import { ACTIVE_AGENT } from './agent.js';
import { atomicWriteFileSync } from './memory.js';

const CLAUDE_CONFIG_PATH = ACTIVE_AGENT.configDir;
const CLAUDE_CREDENTIALS_PATH = ACTIVE_AGENT.credentialsFile;
const PKCE_STATE_PATH = join(CLAUDE_CONFIG_PATH, '.pkce-state.json');

// Backup location for OAuth credentials (same volume, different name to avoid CLI interference)
const CREDENTIALS_BACKUP = join(CLAUDE_CONFIG_PATH, '.codeck-credentials-backup.json');
// Plaintext token file that Claude CLI won't touch — used by getOAuthEnv as fallback
const TOKEN_CACHE_PATH = join(CLAUDE_CONFIG_PATH, '.codeck-oauth-token');
// Account info cache — survives CLI credential overwrites
const ACCOUNT_INFO_CACHE_PATH = join(CLAUDE_CONFIG_PATH, '.codeck-account-info.json');

/**
 * After Claude CLI execution, sync credentials: if CLI wrote a new .credentials.json
 * (possibly in its own format), try to read it and update our plaintext cache + backup.
 * This prevents stale tokens after CLI refreshes/rewrites the file.
 */
/** Check if a token looks like a real OAuth token (not a mock/placeholder from CLI) */
export function isRealToken(token: string): boolean {
  // Real tokens are long (>50 chars). CLI writes "sk-ant-oat01-mock-access-token" (30 chars) as placeholder.
  return token.startsWith('sk-ant-oat01-') && token.length > 50;
}

/**
 * After Claude CLI execution, check if CLI wrote a new valid token to .credentials.json.
 * Only update our cache if the token is real (not a mock placeholder).
 */
export function syncCredentialsAfterCLI(): void {
  try {
    if (!existsSync(CLAUDE_CREDENTIALS_PATH)) return;
    const raw = JSON.parse(readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8'));

    // Try our v2 encrypted format first
    if (raw.version === 2 && raw.claudeAiOauth?.accessToken?.encrypted) {
      const token = decryptValue(raw.claudeAiOauth.accessToken);
      if (token && isRealToken(token)) {
        inMemoryToken = token;
        writeFileSync(TOKEN_CACHE_PATH, token, { mode: 0o600 });
        backupCredentials();
        if (raw.accountInfo) cacheAccountInfo(raw.accountInfo);
        tokenMarkedExpired = false;
        invalidateAuthCache();
        console.log('[Claude] Synced credentials after CLI execution (v2 format)');
        return;
      }
    }

    // Try Claude CLI's own format (plaintext token)
    if (raw.claudeAiOauth?.accessToken && typeof raw.claudeAiOauth.accessToken === 'string') {
      const token = raw.claudeAiOauth.accessToken;
      if (isRealToken(token)) {
        inMemoryToken = token;
        writeFileSync(TOKEN_CACHE_PATH, token, { mode: 0o600 });
        tokenMarkedExpired = false;
        invalidateAuthCache();
        // Re-encrypt and update backup so it stays current with the CLI-refreshed token.
        // Preserve existing accountInfo and refreshToken from the CLI's output.
        const refreshToken = typeof raw.claudeAiOauth?.refreshToken === 'string' ? raw.claudeAiOauth.refreshToken : '';
        const expiresIn = raw.claudeAiOauth?.expiresAt
          ? Math.max(0, Math.round((raw.claudeAiOauth.expiresAt - Date.now()) / 1000))
          : undefined;
        const existingAccount = raw.accountInfo ?? getCachedAccountInfo() ?? undefined;
        saveOAuthToken(token, refreshToken, existingAccount, expiresIn);
        console.log('[Claude] Synced credentials after CLI execution (CLI plaintext format, re-encrypted backup)');
        return;
      }
      if (token.includes('mock')) {
        console.log('[Claude] Ignoring mock token from CLI in .credentials.json');
      }
    }
  } catch (e) {
    console.warn('[Claude] syncCredentialsAfterCLI error:', (e as Error).message);
  }
}

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

/** Save account info to a separate cache file (survives CLI credential overwrites) */
function cacheAccountInfo(info: AccountInfo): void {
  try {
    writeFileSync(ACCOUNT_INFO_CACHE_PATH, JSON.stringify(info), { mode: 0o600 });
  } catch { /* non-fatal */ }
}

/** Read cached account info */
function getCachedAccountInfo(): AccountInfo | null {
  try {
    if (!existsSync(ACCOUNT_INFO_CACHE_PATH)) return null;
    return JSON.parse(readFileSync(ACCOUNT_INFO_CACHE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

/** Backup credentials file after saving */
function backupCredentials(): void {
  try {
    if (existsSync(CLAUDE_CREDENTIALS_PATH)) {
      copyFileSync(CLAUDE_CREDENTIALS_PATH, CREDENTIALS_BACKUP);
    }
  } catch (e) {
    console.warn('[Claude] Failed to backup credentials:', (e as Error).message);
  }
}

/** Restore credentials from backup if missing */
function restoreCredentials(): boolean {
  if (existsSync(CLAUDE_CREDENTIALS_PATH)) return false;
  if (!existsSync(CREDENTIALS_BACKUP)) return false;
  try {
    copyFileSync(CREDENTIALS_BACKUP, CLAUDE_CREDENTIALS_PATH);
    console.log('[Claude] Restored .credentials.json from backup');
    return true;
  } catch (e) {
    console.error('[Claude] Failed to restore credentials:', (e as Error).message);
    return false;
  }
}

// Restore on module load
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
                  copyFileSync(CREDENTIALS_BACKUP, CLAUDE_CREDENTIALS_PATH);
                  console.log('[Claude] WATCH: auto-restored credentials from backup');
                } catch (e) {
                  console.error('[Claude] WATCH: auto-restore failed:', (e as Error).message);
                }
              }
            }
          }, 500);
        } else if (eventType === 'change' || eventType === 'rename') {
          // File was rewritten — only update backup if it's our v2 format (not CLI's mock)
          try {
            const raw = JSON.parse(readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8'));
            if (raw.version === 2) {
              copyFileSync(CLAUDE_CREDENTIALS_PATH, CREDENTIALS_BACKUP);
            }
          } catch { /* ignore */ }
        }
      }
    });
  }
} catch (e) {
  console.warn('[Claude] Could not set up credentials watcher:', (e as Error).message);
}

// OAuth constants (from Claude CLI)
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const OAUTH_SCOPE = 'user:inference user:profile';
const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

// ============ Token Encryption at Rest ============

const ENCRYPTION_SALT = 'codeck-credential-encryption-v1';

interface EncryptedValue {
  encrypted: string;
  iv: string;
  tag: string;
}

interface EncryptedCredentials {
  version: 2;
  claudeAiOauth: {
    accessToken: EncryptedValue;
    refreshToken: EncryptedValue;
    expiresAt: number;
  };
  accountInfo?: AccountInfo;
}

interface PlaintextCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
  accountInfo?: AccountInfo;
}

const CODECK_DIR = process.env.CODECK_DIR || '/workspace/.codeck';
const AUTO_KEY_PATH = join(CODECK_DIR, '.encryption-key');

/**
 * Derive an encryption key from a stable source.
 * Priority: CODECK_ENCRYPTION_KEY env var > auto-generated persisted key > hostname fallback.
 */
function deriveEncryptionKey(): Buffer {
  if (process.env.CODECK_ENCRYPTION_KEY) {
    return scryptSync(process.env.CODECK_ENCRYPTION_KEY, ENCRYPTION_SALT, 32);
  }

  // Auto-generate and persist a random key on first use
  try {
    if (!existsSync(AUTO_KEY_PATH)) {
      if (!existsSync(CODECK_DIR)) mkdirSync(CODECK_DIR, { recursive: true, mode: 0o700 });
      const randomKey = randomBytes(32).toString('hex');
      writeFileSync(AUTO_KEY_PATH, randomKey, { mode: 0o600 });
      console.log('[Security] Generated new encryption key at .codeck/.encryption-key');
    }
    const persistedKey = readFileSync(AUTO_KEY_PATH, 'utf8').trim();
    if (persistedKey.length >= 32) {
      return scryptSync(persistedKey, ENCRYPTION_SALT, 32);
    }
  } catch (e) {
    console.warn('[Security] Could not read/write auto-generated encryption key:', (e as Error).message);
  }

  // Final fallback: hostname-based (least secure)
  console.warn('[Security] Using hostname-based encryption key. Set CODECK_ENCRYPTION_KEY for production.');
  return scryptSync(`codeck-${process.env.HOSTNAME || 'local'}-credential-key`, ENCRYPTION_SALT, 32);
}

function encryptValue(value: string): EncryptedValue {
  const key = deriveEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(value, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag();
  return { encrypted, iv: iv.toString('base64'), tag: tag.toString('base64') };
}

function decryptValue(data: EncryptedValue): string {
  const key = deriveEncryptionKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
  let decrypted = decipher.update(data.encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

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

/**
 * Read and decrypt credentials file.
 * Handles both v2 (encrypted) and legacy (plaintext) formats.
 */
export function readCredentials(): PlaintextCredentials | null {
  if (!existsSync(CLAUDE_CREDENTIALS_PATH)) {
    // Try restore from backup
    if (!restoreCredentials()) return null;
  }
  validateCredentialsPermissions();

  try {
    const raw = JSON.parse(readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8'));

    // v2 encrypted format
    if (raw.version === 2) {
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

    // Legacy plaintext format — return as-is
    return raw as PlaintextCredentials;
  } catch (e) {
    console.log('[Claude] Error reading credentials:', (e as Error).message);
    return null;
  }
}

interface LoginState {
  active: boolean;
  url: string | null;
  error: string | null;
  waitingForCode: boolean;
  startedAt: number;
}

interface LoginCallbacks {
  onUrl?: (url: string) => void;
  onSuccess?: () => void;
  onError?: (err?: Error) => void;
}

interface LoginResult {
  started: boolean;
  success?: boolean;
  message?: string;
  url?: string | null;
  error?: string;
}

interface SendCodeResult {
  success: boolean;
  error?: string;
}

export interface AccountInfo {
  email: string | null;
  accountUuid: string | null;
  organizationName: string | null;
  organizationUuid: string | null;
}

/**
 * Save OAuth token to credentials file
 * Format required by Claude Code
 */
function saveOAuthToken(token: string, refreshToken = '', accountInfo?: AccountInfo, expiresIn?: number): boolean {
  console.log('[Claude] Saving OAuth token (encrypted)...');

  if (!existsSync(CLAUDE_CONFIG_PATH)) {
    mkdirSync(CLAUDE_CONFIG_PATH, { recursive: true, mode: 0o700 });
  }

  // Use actual expires_in from OAuth response (seconds), fallback to 365 days
  const ttlMs = expiresIn ? expiresIn * 1000 : 365 * 24 * 60 * 60 * 1000;

  const credentials: EncryptedCredentials = {
    version: 2,
    claudeAiOauth: {
      accessToken: encryptValue(token),
      refreshToken: encryptValue(refreshToken),
      expiresAt: Date.now() + ttlMs,
    },
    accountInfo,
  };

  atomicWriteFileSync(CLAUDE_CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  backupCredentials();

  // Save plaintext token separately — Claude CLI won't touch this file
  try {
    writeFileSync(TOKEN_CACHE_PATH, token, { mode: 0o600 });
  } catch { /* non-fatal */ }

  // Cache account info separately so it survives CLI credential overwrites
  if (accountInfo) {
    cacheAccountInfo(accountInfo);
  }

  // Set in-memory token — authoritative while server runs
  inMemoryToken = token;

  // Clear expired flag and record save time — this token is fresh
  tokenMarkedExpired = false;
  lastTokenSaveAt = Date.now();
  invalidateAuthCache();

  console.log('[Claude] ✓ Token saved (memory + encrypted + plaintext cache)');
  return true;
}

// ============ PKCE Helpers ============

function base64url(buffer: Buffer): string {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

function generateState(): string {
  return base64url(randomBytes(32));
}

// ============ Token Refresh ============

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes before expiry
let refreshInProgress = false;

/**
 * Attempt to refresh the access token using the stored refresh token.
 * This is async and runs in the background — the caller should not await it.
 */
async function performTokenRefresh(refreshToken: string): Promise<boolean> {
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
    const accountInfo = existing?.accountInfo;

    saveOAuthToken(tokenData.access_token, tokenData.refresh_token || refreshToken, accountInfo, tokenData.expires_in);
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
function tryRefreshToken(creds: Record<string, unknown>): boolean {
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
function scheduleProactiveRefresh(creds: Record<string, unknown>): void {
  const oauth = creds.claudeAiOauth as { refreshToken?: string; expiresAt?: number } | undefined;
  if (!oauth?.refreshToken || !oauth?.expiresAt) return;

  const now = Date.now();
  const timeUntilExpiry = oauth.expiresAt - now;
  if (timeUntilExpiry > 0 && timeUntilExpiry <= REFRESH_MARGIN_MS) {
    console.log('[Claude] Token expires soon, triggering proactive refresh');
    performTokenRefresh(oauth.refreshToken);
  }
}

// ============ Background Token Refresh Monitor ============

const REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;      // Check every 5 minutes
const REFRESH_MARGIN_PROACTIVE_MS = 30 * 60 * 1000;   // Refresh 30 min before expiry

let refreshMonitorInterval: ReturnType<typeof setInterval> | null = null;

export function startTokenRefreshMonitor(): void {
  if (refreshMonitorInterval) return; // Already running

  console.log('[Claude] Starting token refresh monitor (every 5min, 30min margin)');

  refreshMonitorInterval = setInterval(async () => {
    // Skip if token already marked expired with no recovery path
    if (tokenMarkedExpired) return;

    const creds = readCredentials();
    if (!creds?.claudeAiOauth?.refreshToken || !creds.claudeAiOauth.expiresAt) return;

    const timeUntilExpiry = creds.claudeAiOauth.expiresAt - Date.now();

    if (timeUntilExpiry <= 0) {
      // Already expired — try refresh before giving up
      console.log('[Claude] Token expired, attempting recovery via refresh token...');
      const ok = await performTokenRefresh(creds.claudeAiOauth.refreshToken);
      if (!ok) {
        console.log('[Claude] Refresh failed — token is dead, user must re-login');
      }
    } else if (timeUntilExpiry <= REFRESH_MARGIN_PROACTIVE_MS) {
      // Expiring soon — refresh proactively
      console.log(`[Claude] Token expires in ${Math.round(timeUntilExpiry / 60000)}min, refreshing...`);
      await performTokenRefresh(creds.claudeAiOauth.refreshToken);
    }
  }, REFRESH_CHECK_INTERVAL_MS);
}

export function stopTokenRefreshMonitor(): void {
  if (refreshMonitorInterval) {
    clearInterval(refreshMonitorInterval);
    refreshMonitorInterval = null;
  }
}

// ============ Auth Check ============

/**
 * Check if Claude CLI is installed
 */
let claudeInstalled: boolean | null = null;

export function isClaudeInstalled(): boolean {
  if (claudeInstalled !== null) return claudeInstalled;
  try {
    execSync(`${ACTIVE_AGENT.command} ${ACTIVE_AGENT.flags.version}`, { stdio: 'pipe' });
    claudeInstalled = true;
  } catch {
    claudeInstalled = false;
  }
  return claudeInstalled;
}

let authCache = { checked: false, authenticated: false, checkedAt: 0 };
let tokenMarkedExpired = false;
// Timestamp of the last successful token save — used to distinguish fresh logins from stale cache
let lastTokenSaveAt = 0;
const AUTH_CACHE_TTL = 3000;

// In-memory token — authoritative while server is running.
// File deletions (Docker WSL2 sync) cannot break auth once a token is loaded.
let inMemoryToken: string | null = null;

/** Get the in-memory token (authoritative, survives file deletions) */
export function getInMemoryToken(): string | null {
  return inMemoryToken;
}

/** Reset in-memory token — ONLY for testing */
export function _resetInMemoryTokenForTesting(): void {
  inMemoryToken = null;
}

/**
 * Check if there is an active Claude session.
 * Priority: 1) env var, 2) .credentials.json, 3) plaintext cache, 4) oauthAccount config
 *
 * tokenMarkedExpired (set by 401) forces false UNLESS a new token was saved after the 401.
 */
export function isClaudeAuthenticated(): boolean {
  const now = Date.now();
  if (authCache.checked && (now - authCache.checkedAt) < AUTH_CACHE_TTL) {
    return authCache.authenticated;
  }

  // If token was marked expired by an API call (401) and no new token has been saved since,
  // don't trust any file — force re-login
  if (tokenMarkedExpired) {
    authCache = { checked: true, authenticated: false, checkedAt: now };
    return false;
  }

  // 1) In-memory token is authoritative — survives file deletions
  if (inMemoryToken && isRealToken(inMemoryToken)) {
    authCache = { checked: true, authenticated: true, checkedAt: now };
    return true;
  }

  // 2) Check environment variable
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN && process.env.CLAUDE_CODE_OAUTH_TOKEN.startsWith('sk-ant-oat01-')) {
    authCache = { checked: true, authenticated: true, checkedAt: now };
    return true;
  }

  // 3) Check credentials file (handles both encrypted v2 and legacy plaintext)
  const creds = readCredentials();
  if (creds?.claudeAiOauth?.accessToken && isRealToken(creds.claudeAiOauth.accessToken)) {
    // Cache in memory for resilience
    inMemoryToken = creds.claudeAiOauth.accessToken;
    // Check if the token has expired
    if (creds.claudeAiOauth.expiresAt && creds.claudeAiOauth.expiresAt <= now) {
      console.log('[Claude] ⚠ Token has expired, attempting refresh...');
      const refreshed = tryRefreshToken(creds as Record<string, unknown>);
      if (!refreshed) {
        authCache = { checked: true, authenticated: false, checkedAt: now };
        return false;
      }
    }
    // Proactively refresh if token is within 5 minutes of expiry
    scheduleProactiveRefresh(creds as Record<string, unknown>);
    authCache = { checked: true, authenticated: true, checkedAt: now };
    return true;
  }

  // 4) Check plaintext token cache (survives Claude CLI rewriting .credentials.json)
  const cached = getCachedOAuthToken();
  if (cached) {
    inMemoryToken = cached; // Cache in memory for resilience
    authCache = { checked: true, authenticated: true, checkedAt: now };
    return true;
  }

  authCache = { checked: true, authenticated: false, checkedAt: now };
  return false;
}

export function invalidateAuthCache(): void {
  authCache = { checked: false, authenticated: false, checkedAt: 0 };
}

/**
 * Mark the current token as expired (called when an API returns 401).
 * This forces isClaudeAuthenticated() to return false until a new login.
 */
export function markTokenExpired(): void {
  console.log('[Claude] ⚠ Token marked as expired (API returned 401)');
  tokenMarkedExpired = true;
  inMemoryToken = null;
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

function clearAllCredentialFiles(): void {
  try { if (existsSync(TOKEN_CACHE_PATH)) unlinkSync(TOKEN_CACHE_PATH); } catch { /* ignore */ }
  try { if (existsSync(CREDENTIALS_BACKUP)) unlinkSync(CREDENTIALS_BACKUP); } catch { /* ignore */ }
  try { if (existsSync(CLAUDE_CREDENTIALS_PATH)) unlinkSync(CLAUDE_CREDENTIALS_PATH); } catch { /* ignore */ }
  console.log('[Claude] Cleared all cached credentials');
}

// ============ Login Flow (direct OAuth PKCE) ============

// PKCE state for current login flow
let currentCodeVerifier: string | null = null;
let currentState: string | null = null;
let currentNonce: string | null = null;

let loginState: LoginState = {
  active: false,
  url: null,
  error: null,
  waitingForCode: false,
  startedAt: 0,
};

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// ---- PKCE state persistence (survives server restart during login) ----

interface PkceStateFile {
  codeVerifier: string;
  state: string;
  nonce: string;
  url: string | null;
  startedAt: number;
}

function savePkceState(): void {
  if (!currentCodeVerifier || !currentState) return;
  try {
    const data: PkceStateFile = {
      codeVerifier: currentCodeVerifier,
      state: currentState,
      nonce: currentNonce || '',
      url: loginState.url,
      startedAt: loginState.startedAt,
    };
    atomicWriteFileSync(PKCE_STATE_PATH, JSON.stringify(data), { mode: 0o600 });
  } catch (e) {
    console.log('[Claude] Failed to persist PKCE state:', (e as Error).message);
  }
}

function loadPkceState(): boolean {
  try {
    if (!existsSync(PKCE_STATE_PATH)) return false;
    const raw = readFileSync(PKCE_STATE_PATH, 'utf-8');
    const data: PkceStateFile = JSON.parse(raw);
    // Check if the persisted state is expired
    if (data.startedAt > 0 && Date.now() - data.startedAt > LOGIN_TIMEOUT_MS) {
      deletePkceState();
      return false;
    }
    currentCodeVerifier = data.codeVerifier;
    currentState = data.state;
    currentNonce = data.nonce || null;
    loginState = {
      active: true,
      url: data.url,
      error: null,
      waitingForCode: true,
      startedAt: data.startedAt,
    };
    console.log('[Claude] Restored PKCE state from file');
    return true;
  } catch {
    deletePkceState();
    return false;
  }
}

function deletePkceState(): void {
  try {
    if (existsSync(PKCE_STATE_PATH)) unlinkSync(PKCE_STATE_PATH);
  } catch { /* ignore */ }
}

function isLoginStale(): boolean {
  if (!loginState.active) return false;
  if (loginState.startedAt > 0 && Date.now() - loginState.startedAt > LOGIN_TIMEOUT_MS) {
    console.log('[Claude] Login timeout (more than 5 minutes)');
    return true;
  }
  return false;
}

function cleanupLogin(): void {
  currentCodeVerifier = null;
  currentState = null;
  currentNonce = null;
  loginState = { active: false, url: null, error: null, waitingForCode: false, startedAt: 0 };
  deletePkceState();
}

export function getLoginState(): LoginState {
  if (isLoginStale()) {
    cleanupLogin();
    return { ...loginState };
  }
  // Try to restore from persisted state if not active in memory
  if (!loginState.active) {
    loadPkceState();
  }
  if (isLoginStale()) {
    cleanupLogin();
  }
  return { ...loginState };
}

/**
 * Start the OAuth PKCE login process.
 * Generates the authorization URL directly without using claude setup-token.
 */
export function startClaudeLogin(options: LoginCallbacks = {}): Promise<LoginResult> {
  return new Promise((resolve) => {
    if (isLoginStale()) {
      console.log('[Claude] Cleaning stale login before restarting');
      cleanupLogin();
    }

    if (loginState.active && loginState.url && loginState.waitingForCode) {
      resolve({ started: false, message: 'Waiting for code', url: loginState.url });
      return;
    }

    if (loginState.active) {
      resolve({ started: false, message: 'Login in progress', url: loginState.url });
      return;
    }

    console.log('\n🔐 Starting OAuth PKCE authentication...\n');

    cleanupLogin();
    loginState = { active: true, url: null, error: null, waitingForCode: false, startedAt: Date.now() };

    // Generate PKCE values + nonce for replay prevention
    currentCodeVerifier = generateCodeVerifier();
    currentState = generateState();
    currentNonce = base64url(randomBytes(32));
    const codeChallenge = generateCodeChallenge(currentCodeVerifier);

    // Build OAuth URL
    const params = new URLSearchParams({
      code: 'true',
      client_id: OAUTH_CLIENT_ID,
      response_type: 'code',
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: currentState,
      nonce: currentNonce,
    });

    const url = `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;

    loginState.url = url;
    loginState.waitingForCode = true;

    // Persist PKCE state to survive server restart during login
    savePkceState();

    console.log('[Claude] ✓ OAuth URL generated');
    console.log('[Claude] URL:', url.substring(0, 80) + '...');

    options.onUrl?.(url);

    resolve({ started: true, message: 'Login started', url });
  });
}

export function cancelLogin(): void {
  cleanupLogin();
  console.log('[Claude] Login cancelled');
}

/**
 * Receive the authorization code and exchange it for an access token.
 * Also accepts direct OAuth tokens (sk-ant-oat01-...) as fallback.
 */
export async function sendLoginCode(code: string): Promise<SendCodeResult> {
  let cleanCode = code.trim();

  // The callback page shows code#state format - extract code and validate state
  if (cleanCode.includes('#')) {
    const [codeOnly, returnedState] = cleanCode.split('#');
    if (currentState && returnedState && returnedState !== currentState) {
      return { success: false, error: 'State mismatch — possible CSRF. Login again.' };
    }
    cleanCode = codeOnly;
  }
  // Also handle &state= format just in case
  if (cleanCode.includes('&')) {
    cleanCode = cleanCode.split('&')[0];
  }

  // Handle full callback URL pasted
  if (cleanCode.startsWith('http')) {
    try {
      const url = new URL(cleanCode);
      const codeParam = url.searchParams.get('code');
      if (codeParam) {
        console.log('[Claude] Full URL pasted, extracting code parameter');
        cleanCode = codeParam;
      }
    } catch {
      // not a URL, continue
    }
  }

  console.log('[Claude] Received authorization code (length:', cleanCode.length, ')');

  // Direct OAuth token - save directly
  if (cleanCode.startsWith('sk-ant-oat01-')) {
    saveOAuthToken(cleanCode);
    invalidateAuthCache();
    if (isClaudeAuthenticated()) {
      cleanupLogin();
      console.log('[Claude] ✓ Token saved successfully');
      return { success: true };
    }
    return { success: false, error: 'Token saved but could not be verified.' };
  }

  // Exchange authorization code for access token via OAuth PKCE
  if (!currentCodeVerifier) {
    return { success: false, error: 'Login session expired. Click "Login" again.' };
  }

  console.log('[Claude] Exchanging code for token...');
  console.log('[Claude] code_verifier length:', currentCodeVerifier.length, ', state length:', currentState?.length);

  try {
    const body = JSON.stringify({
      grant_type: 'authorization_code',
      code: cleanCode,
      redirect_uri: OAUTH_REDIRECT_URI,
      client_id: OAUTH_CLIENT_ID,
      code_verifier: currentCodeVerifier,
      state: currentState,
    });

    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
    });

    const responseText = await response.text();
    console.log('[Claude] Token exchange status:', response.status);

    if (!response.ok) {
      console.log('[Claude] Token exchange error:', responseText.substring(0, 200));
      // Authorization codes are single-use. After any failed exchange, force a fresh login.
      cleanupLogin();
      return { success: false, error: `Error exchanging code (${response.status}). Login again to get a new code.` };
    }

    let tokenData: {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      account?: { email_address?: string; uuid?: string };
      organization?: { name?: string; uuid?: string };
    };
    try {
      tokenData = JSON.parse(responseText);
    } catch {
      console.log('[Claude] Error parsing token response:', responseText.substring(0, 200));
      return { success: false, error: 'Invalid response from OAuth server.' };
    }

    if (tokenData.error) {
      console.log('[Claude] OAuth error:', tokenData.error);
      cleanupLogin();
      return { success: false, error: `OAuth error: ${tokenData.error}. Login again.` };
    }

    if (!tokenData.access_token) {
      console.log('[Claude] No access_token in response');
      cleanupLogin();
      return { success: false, error: 'No access token received. Login again.' };
    }

    // Extract account info from token exchange response
    const accountInfo: AccountInfo = {
      email: tokenData.account?.email_address || null,
      accountUuid: tokenData.account?.uuid || null,
      organizationName: tokenData.organization?.name || null,
      organizationUuid: tokenData.organization?.uuid || null,
    };
    console.log('[Claude] Account info received for', accountInfo.organizationName || 'personal account');

    // Save token + account info (use actual expiry from OAuth response)
    saveOAuthToken(tokenData.access_token, tokenData.refresh_token || '', accountInfo, tokenData.expires_in);
    tokenMarkedExpired = false;
    invalidateAuthCache();

    if (isClaudeAuthenticated()) {
      cleanupLogin();
      console.log('[Claude] ✓ Authentication successful via OAuth PKCE');
      return { success: true };
    }

    return { success: false, error: 'Token received but could not be verified.' };
  } catch (e) {
    const errMsg = (e as Error).message;
    console.log('[Claude] Token exchange exception:', errMsg);
    cleanupLogin();
    return { success: false, error: `Network error: ${errMsg}. Login again.` };
  }
}

/**
 * Read stored account info — tries credentials file first, then backup, then separate cache.
 * Account info survives CLI credential overwrites via the dedicated cache file.
 */
export function getAccountInfo(): AccountInfo | null {
  // Priority 1: credentials file (has latest from OAuth exchange)
  try {
    const creds = readCredentials();
    if (creds?.accountInfo) {
      return creds.accountInfo;
    }
  } catch {
    // ignore
  }

  // Priority 2: backup credentials file
  try {
    if (existsSync(CREDENTIALS_BACKUP)) {
      const raw = JSON.parse(readFileSync(CREDENTIALS_BACKUP, 'utf-8'));
      if (raw.version === 2 && raw.accountInfo) {
        return raw.accountInfo as AccountInfo;
      }
    }
  } catch {
    // ignore
  }

  // Priority 3: separate account info cache
  return getCachedAccountInfo();
}

/**
 * Full Claude status
 */
export function getClaudeStatus() {
  return {
    installed: isClaudeInstalled(),
    authenticated: isClaudeAuthenticated(),
    configPath: CLAUDE_CONFIG_PATH,
    loginState: getLoginState(),
    accountInfo: getAccountInfo(),
  };
}
