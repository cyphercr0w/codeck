/**
 * Claude OAuth PKCE authentication — main facade.
 *
 * Sub-modules:
 *   ./auth-anthropic/encryption.ts   — AES-256-GCM encrypt/decrypt, key derivation
 *   ./auth-anthropic/account-cache.ts — Account info caching
 *   ./auth-anthropic/token-manager.ts — Token cache, refresh, file watcher
 *
 * This file contains the orchestration layer: login flow, auth checks,
 * logout, and the public API surface that the rest of the codebase imports.
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { randomBytes, createHash } from "crypto";
import { join } from "path";
import { ACTIVE_AGENT } from "./agent.js";
import { atomicWriteFileSync } from "./memory.js";

// Re-export types from sub-modules
export type {
	AccountInfo,
	PlaintextCredentials,
	EncryptedValue,
	EncryptedCredentials,
} from "./auth-anthropic/encryption.js";

// Re-export encryption utilities
export {
	encryptValue,
	decryptValue,
	deriveEncryptionKey,
	CODECK_DIR,
	AUTO_KEY_PATH,
} from "./auth-anthropic/encryption.js";

// Re-export account cache
export {
	cacheAccountInfo,
	getCachedAccountInfo,
	ACCOUNT_INFO_CACHE_PATH,
} from "./auth-anthropic/account-cache.js";

// Re-export token manager
export {
	isRealToken,
	readCredentials,
	getCachedOAuthToken,
	saveOAuthToken,
	backupCredentials,
	syncCredentialsAfterCLI,
	markTokenExpired,
	invalidateAuthCache,
	getInMemoryToken,
	getInMemoryTokenExpiresAt,
	_resetInMemoryTokenForTesting,
	setInMemoryToken,
	startTokenRefreshMonitor,
	stopTokenRefreshMonitor,
	performTokenRefresh,
	tryRefreshToken,
	scheduleProactiveRefresh,
	clearAllCredentialFiles,
	TOKEN_CACHE_PATH,
} from "./auth-anthropic/token-manager.js";

// Imports used internally by this facade
import {
	isRealToken,
	readCredentials,
	getCachedOAuthToken,
	saveOAuthToken,
	invalidateAuthCache,
	getInMemoryToken,
	stopTokenRefreshMonitor,
	clearAllCredentialFiles,
	tryRefreshToken,
	scheduleProactiveRefresh,
	tokenMarkedExpired,
	setTokenMarkedExpired,
	setLoggedOut,
	getAuthCache,
	setAuthCache,
	getAuthCacheTTL,
} from "./auth-anthropic/token-manager.js";
import { getCachedAccountInfo } from "./auth-anthropic/account-cache.js";
import type { AccountInfo } from "./auth-anthropic/encryption.js";

// ============ Path Constants ============

const CLAUDE_CONFIG_PATH = ACTIVE_AGENT.configDir;
const CLAUDE_CREDENTIALS_PATH = ACTIVE_AGENT.credentialsFile;
const PKCE_STATE_PATH = join(CLAUDE_CONFIG_PATH, ".pkce-state.json");

// Backup location for reading account info in getAccountInfo()
const CREDENTIALS_BACKUP = join(
	CLAUDE_CONFIG_PATH,
	".codeck-credentials-backup.json",
);

// OAuth constants (from Claude CLI)
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const OAUTH_SCOPE = "user:inference user:profile";
const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

// ============ Auth Check ============

/**
 * Check if Claude CLI is installed
 */
let claudeInstalled: boolean | null = null;

export function isClaudeInstalled(): boolean {
	if (claudeInstalled !== null) return claudeInstalled;
	try {
		execFileSync(ACTIVE_AGENT.command, [ACTIVE_AGENT.flags.version], {
			stdio: "pipe",
		});
		claudeInstalled = true;
	} catch {
		claudeInstalled = false;
	}
	return claudeInstalled;
}

/**
 * Check if there is an active Claude session.
 * Priority: 1) env var, 2) .credentials.json, 3) plaintext cache, 4) oauthAccount config
 *
 * tokenMarkedExpired (set by 401) forces false UNLESS a new token was saved after the 401.
 */
export function isClaudeAuthenticated(): boolean {
	const now = Date.now();
	const authCache = getAuthCache();
	const AUTH_CACHE_TTL = getAuthCacheTTL();
	if (authCache.checked && now - authCache.checkedAt < AUTH_CACHE_TTL) {
		return authCache.authenticated;
	}

	// If token was marked expired by an API call (401) and no new token has been saved since,
	// don't trust any file — force re-login
	if (tokenMarkedExpired) {
		setAuthCache({ checked: true, authenticated: false, checkedAt: now });
		return false;
	}

	// 1) In-memory token is authoritative — survives file deletions
	const memToken = getInMemoryToken();
	if (memToken && isRealToken(memToken)) {
		setAuthCache({ checked: true, authenticated: true, checkedAt: now });
		return true;
	}

	// 2) Check environment variable
	if (
		process.env.CLAUDE_CODE_OAUTH_TOKEN &&
		process.env.CLAUDE_CODE_OAUTH_TOKEN.startsWith("sk-ant-oat01-")
	) {
		setAuthCache({ checked: true, authenticated: true, checkedAt: now });
		return true;
	}

	// 3) Check credentials file (handles both encrypted v2 and legacy plaintext)
	const creds = readCredentials();
	if (
		creds?.claudeAiOauth?.accessToken &&
		isRealToken(creds.claudeAiOauth.accessToken)
	) {
		// Check if the token has expired
		if (creds.claudeAiOauth.expiresAt && creds.claudeAiOauth.expiresAt <= now) {
			console.log("[Claude] ⚠ Token has expired, attempting refresh...");
			const refreshed = tryRefreshToken(creds as Record<string, unknown>);
			if (!refreshed) {
				setAuthCache({ checked: true, authenticated: false, checkedAt: now });
				return false;
			}
		}
		// Proactively refresh if token is within 5 minutes of expiry
		scheduleProactiveRefresh(creds as Record<string, unknown>);
		setAuthCache({ checked: true, authenticated: true, checkedAt: now });
		return true;
	}

	// 4) Check plaintext token cache (survives Claude CLI rewriting .credentials.json)
	const cached = getCachedOAuthToken();
	if (cached) {
		setAuthCache({ checked: true, authenticated: true, checkedAt: now });
		return true;
	}

	setAuthCache({ checked: true, authenticated: false, checkedAt: now });
	return false;
}

// ============ Login Flow (direct OAuth PKCE) ============

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

// ---- PKCE Helpers ----

function base64url(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function generateCodeVerifier(): string {
	return base64url(randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
	return base64url(createHash("sha256").update(verifier).digest());
}

function generateState(): string {
	return base64url(randomBytes(32));
}

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
			nonce: currentNonce || "",
			url: loginState.url,
			startedAt: loginState.startedAt,
		};
		atomicWriteFileSync(PKCE_STATE_PATH, JSON.stringify(data), { mode: 0o600 });
	} catch (e) {
		console.log("[Claude] Failed to persist PKCE state:", (e as Error).message);
	}
}

function loadPkceState(): boolean {
	try {
		if (!existsSync(PKCE_STATE_PATH)) return false;
		const raw = readFileSync(PKCE_STATE_PATH, "utf-8");
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
		console.log("[Claude] Restored PKCE state from file");
		return true;
	} catch {
		deletePkceState();
		return false;
	}
}

function deletePkceState(): void {
	try {
		if (existsSync(PKCE_STATE_PATH)) unlinkSync(PKCE_STATE_PATH);
	} catch {
		/* ignore */
	}
}

function isLoginStale(): boolean {
	if (!loginState.active) return false;
	if (
		loginState.startedAt > 0 &&
		Date.now() - loginState.startedAt > LOGIN_TIMEOUT_MS
	) {
		console.log("[Claude] Login timeout (more than 5 minutes)");
		return true;
	}
	return false;
}

function cleanupLogin(): void {
	currentCodeVerifier = null;
	currentState = null;
	currentNonce = null;
	loginState = {
		active: false,
		url: null,
		error: null,
		waitingForCode: false,
		startedAt: 0,
	};
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
export function startClaudeLogin(
	options: LoginCallbacks = {},
): Promise<LoginResult> {
	return new Promise((resolve) => {
		if (isLoginStale()) {
			console.log("[Claude] Cleaning stale login before restarting");
			cleanupLogin();
		}

		if (loginState.active && loginState.url && loginState.waitingForCode) {
			resolve({
				started: false,
				message: "Waiting for code",
				url: loginState.url,
			});
			return;
		}

		if (loginState.active) {
			resolve({
				started: false,
				message: "Login in progress",
				url: loginState.url,
			});
			return;
		}

		console.log("\n🔐 Starting OAuth PKCE authentication...\n");

		cleanupLogin();
		loginState = {
			active: true,
			url: null,
			error: null,
			waitingForCode: false,
			startedAt: Date.now(),
		};

		// Generate PKCE values + nonce for replay prevention
		currentCodeVerifier = generateCodeVerifier();
		currentState = generateState();
		currentNonce = base64url(randomBytes(32));
		const codeChallenge = generateCodeChallenge(currentCodeVerifier);

		// Build OAuth URL
		const params = new URLSearchParams({
			code: "true",
			client_id: OAUTH_CLIENT_ID,
			response_type: "code",
			redirect_uri: OAUTH_REDIRECT_URI,
			scope: OAUTH_SCOPE,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
			state: currentState,
			nonce: currentNonce,
		});

		const url = `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;

		loginState.url = url;
		loginState.waitingForCode = true;

		// Persist PKCE state to survive server restart during login
		savePkceState();

		console.log("[Claude] ✓ OAuth URL generated");
		console.log("[Claude] URL:", url.substring(0, 80) + "...");

		options.onUrl?.(url);

		resolve({ started: true, message: "Login started", url });
	});
}

export function cancelLogin(): void {
	cleanupLogin();
	console.log("[Claude] Login cancelled");
}

/**
 * Receive the authorization code and exchange it for an access token.
 * Also accepts direct OAuth tokens (sk-ant-oat01-...) as fallback.
 */
export async function sendLoginCode(code: string): Promise<SendCodeResult> {
	let cleanCode = code.trim();

	// The callback page shows code#state format - extract code and validate state
	if (cleanCode.includes("#")) {
		const [codeOnly, returnedState] = cleanCode.split("#");
		if (currentState && returnedState && returnedState !== currentState) {
			return {
				success: false,
				error: "State mismatch — possible CSRF. Login again.",
			};
		}
		cleanCode = codeOnly;
	}
	// Also handle &state= format just in case
	if (cleanCode.includes("&")) {
		cleanCode = cleanCode.split("&")[0];
	}

	// Handle full callback URL pasted
	if (cleanCode.startsWith("http")) {
		try {
			const url = new URL(cleanCode);
			const codeParam = url.searchParams.get("code");
			if (codeParam) {
				console.log("[Claude] Full URL pasted, extracting code parameter");
				cleanCode = codeParam;
			}
		} catch {
			// not a URL, continue
		}
	}

	console.log(
		"[Claude] Received authorization code (length:",
		cleanCode.length,
		")",
	);

	// Direct OAuth token - save directly
	if (cleanCode.startsWith("sk-ant-oat01-")) {
		saveOAuthToken(cleanCode);
		invalidateAuthCache();
		if (isClaudeAuthenticated()) {
			cleanupLogin();
			console.log("[Claude] ✓ Token saved successfully");
			return { success: true };
		}
		return { success: false, error: "Token saved but could not be verified." };
	}

	// Exchange authorization code for access token via OAuth PKCE
	if (!currentCodeVerifier) {
		return {
			success: false,
			error: 'Login session expired. Click "Login" again.',
		};
	}

	console.log("[Claude] Exchanging code for token...");
	console.log(
		"[Claude] code_verifier length:",
		currentCodeVerifier.length,
		", state length:",
		currentState?.length,
	);

	try {
		const body = JSON.stringify({
			grant_type: "authorization_code",
			code: cleanCode,
			redirect_uri: OAUTH_REDIRECT_URI,
			client_id: OAUTH_CLIENT_ID,
			code_verifier: currentCodeVerifier,
			state: currentState,
		});

		const response = await fetch(OAUTH_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body,
		});

		const responseText = await response.text();
		console.log("[Claude] Token exchange status:", response.status);

		if (!response.ok) {
			console.log(
				"[Claude] Token exchange error:",
				responseText.substring(0, 200),
			);
			// Authorization codes are single-use. After any failed exchange, force a fresh login.
			cleanupLogin();
			return {
				success: false,
				error: `Error exchanging code (${response.status}). Login again to get a new code.`,
			};
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
			console.log(
				"[Claude] Error parsing token response:",
				responseText.substring(0, 200),
			);
			return { success: false, error: "Invalid response from OAuth server." };
		}

		if (tokenData.error) {
			console.log("[Claude] OAuth error:", tokenData.error);
			cleanupLogin();
			return {
				success: false,
				error: `OAuth error: ${tokenData.error}. Login again.`,
			};
		}

		if (!tokenData.access_token) {
			console.log("[Claude] No access_token in response");
			cleanupLogin();
			return {
				success: false,
				error: "No access token received. Login again.",
			};
		}

		// Extract account info from token exchange response
		const accountInfo: AccountInfo = {
			email: tokenData.account?.email_address || null,
			accountUuid: tokenData.account?.uuid || null,
			organizationName: tokenData.organization?.name || null,
			organizationUuid: tokenData.organization?.uuid || null,
		};
		console.log(
			"[Claude] Account info received for",
			accountInfo.organizationName || "personal account",
		);

		// Save token + account info (use actual expiry from OAuth response)
		saveOAuthToken(
			tokenData.access_token,
			tokenData.refresh_token || "",
			accountInfo,
			tokenData.expires_in,
		);
		setTokenMarkedExpired(false);
		invalidateAuthCache();

		if (isClaudeAuthenticated()) {
			cleanupLogin();
			console.log("[Claude] ✓ Authentication successful via OAuth PKCE");
			return { success: true };
		}

		return {
			success: false,
			error: "Token received but could not be verified.",
		};
	} catch (e) {
		const errMsg = (e as Error).message;
		console.log("[Claude] Token exchange exception:", errMsg);
		cleanupLogin();
		return { success: false, error: `Network error: ${errMsg}. Login again.` };
	}
}

// ============ Logout ============

/** Full Claude logout: clear all auth state (tokens, caches, monitors) but keep workspace data. */
export function logoutClaude(): void {
	console.log("[Claude] Logging out — clearing all OAuth state");

	// Prevent file watcher from re-syncing deleted credentials
	setLoggedOut(true);

	// Clear in-memory state via token manager
	setTokenMarkedExpired(false);
	invalidateAuthCache();

	// Stop background monitors
	stopTokenRefreshMonitor();

	// Clear all credential files on disk
	clearAllCredentialFiles();

	// Clear PKCE login state if active
	cleanupLogin();

	console.log("[Claude] ✓ Logged out — ready for new login");
}

// ============ Account Info ============

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
			const raw = JSON.parse(readFileSync(CREDENTIALS_BACKUP, "utf-8"));
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

// ============ Status ============

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
