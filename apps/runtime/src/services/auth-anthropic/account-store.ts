/**
 * Per-config-dir credential store for ADDITIONAL Claude accounts.
 *
 * The default/first account is managed by token-manager.ts against ~/.claude.
 * Additional accounts each live in their own CLAUDE_CONFIG_DIR
 * (e.g. /workspace/.codeck/accounts/<uuid>/). This module reads/writes/refreshes
 * the CLI-compatible plaintext `.credentials.json` (+ encrypted backup) for an
 * arbitrary config directory, reusing the shared AES-256-GCM helpers.
 *
 * Keeping this separate from token-manager.ts means the working single-account
 * flow is never touched.
 */
import {
	existsSync,
	readFileSync,
	mkdirSync,
	chmodSync,
	statSync,
} from "fs";
import { join } from "path";
import { atomicWriteFileSync } from "../memory.js";
import {
	encryptValue,
	decryptValue,
	type EncryptedCredentials,
	type PlaintextCredentials,
	type AccountInfo,
} from "./encryption.js";

// OAuth constants (from Claude CLI) — duplicated intentionally to stay decoupled
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

/** Derived credential file paths inside a config directory. */
export interface AccountStorePaths {
	configDir: string;
	credentialsFile: string; // CLI-native plaintext credentials
	backupFile: string; // encrypted backup
	tokenCacheFile: string; // plaintext token fallback
	accountInfoFile: string; // account metadata cache
}

export function storePathsFor(configDir: string): AccountStorePaths {
	return {
		configDir,
		credentialsFile: join(configDir, ".credentials.json"),
		backupFile: join(configDir, ".codeck-credentials-backup.json"),
		tokenCacheFile: join(configDir, ".codeck-oauth-token"),
		accountInfoFile: join(configDir, ".codeck-account-info.json"),
	};
}

function fixPermissions(file: string): void {
	try {
		if (!existsSync(file)) return;
		if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
	} catch {
		/* non-fatal */
	}
}

/** Decrypt the encrypted backup file if present. */
function readBackup(paths: AccountStorePaths): PlaintextCredentials | null {
	try {
		if (!existsSync(paths.backupFile)) return null;
		const raw = JSON.parse(readFileSync(paths.backupFile, "utf-8"));
		if (raw.version === 2 && raw.claudeAiOauth?.accessToken?.encrypted) {
			const enc = raw as EncryptedCredentials;
			return {
				claudeAiOauth: {
					accessToken: decryptValue(enc.claudeAiOauth.accessToken),
					refreshToken: enc.claudeAiOauth.refreshToken
						? decryptValue(enc.claudeAiOauth.refreshToken)
						: "",
					expiresAt: enc.claudeAiOauth.expiresAt,
				},
				accountInfo: enc.accountInfo,
			};
		}
	} catch {
		/* ignore */
	}
	return null;
}

/**
 * Read credentials for an additional account's config dir.
 * Primary source is the plaintext .credentials.json; falls back to the
 * encrypted backup (e.g. if the CLI wiped the plaintext file).
 */
export function readAccountCredentials(
	configDir: string,
): PlaintextCredentials | null {
	const paths = storePathsFor(configDir);
	if (existsSync(paths.credentialsFile)) {
		fixPermissions(paths.credentialsFile);
		try {
			const raw = JSON.parse(readFileSync(paths.credentialsFile, "utf-8"));
			// Legacy encrypted v2 format — decrypt on the fly
			if (raw.version === 2 && raw.claudeAiOauth?.accessToken?.encrypted) {
				return readBackup(paths);
			}
			if (raw.claudeAiOauth?.accessToken) return raw as PlaintextCredentials;
		} catch {
			/* fall through to backup */
		}
	}
	return readBackup(paths);
}

/** Read the cached account metadata (survives CLI credential rewrites). */
export function readAccountInfo(configDir: string): AccountInfo | null {
	const paths = storePathsFor(configDir);
	const creds = readAccountCredentials(configDir);
	if (creds?.accountInfo) return creds.accountInfo;
	try {
		if (existsSync(paths.accountInfoFile)) {
			return JSON.parse(readFileSync(paths.accountInfoFile, "utf-8"));
		}
	} catch {
		/* ignore */
	}
	return null;
}

/**
 * Write CLI-compatible plaintext credentials + encrypted backup + caches
 * into an account's config dir.
 */
export function writeAccountCredentials(
	configDir: string,
	token: string,
	refreshToken: string,
	accountInfo: AccountInfo | undefined,
	expiresAt: number,
): void {
	const paths = storePathsFor(configDir);
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
	}

	const plain: PlaintextCredentials = {
		claudeAiOauth: {
			accessToken: token,
			...(refreshToken ? { refreshToken } : {}),
			expiresAt,
		},
		...(accountInfo ? { accountInfo } : {}),
	};
	atomicWriteFileSync(
		paths.credentialsFile,
		JSON.stringify(plain, null, 2),
		{ mode: 0o600 },
	);

	// Encrypted backup
	try {
		const encrypted: EncryptedCredentials = {
			version: 2,
			claudeAiOauth: {
				accessToken: encryptValue(token),
				refreshToken: encryptValue(refreshToken || ""),
				expiresAt,
			},
			accountInfo,
		};
		atomicWriteFileSync(paths.backupFile, JSON.stringify(encrypted, null, 2), {
			mode: 0o600,
		});
	} catch {
		/* non-fatal */
	}

	// Plaintext token + account-info caches
	try {
		atomicWriteFileSync(paths.tokenCacheFile, token, { mode: 0o600 });
	} catch {
		/* non-fatal */
	}
	if (accountInfo) {
		try {
			atomicWriteFileSync(
				paths.accountInfoFile,
				JSON.stringify(accountInfo),
				{ mode: 0o600 },
			);
		} catch {
			/* non-fatal */
		}
	}
}

/** Real OAuth access token check (mirrors token-manager.isRealToken). */
export function isRealAccountToken(token: string | undefined | null): boolean {
	return !!token && token.startsWith("sk-ant-oat01-") && token.length > 50;
}

/**
 * Return a usable access token for an additional account, or null.
 * Synchronous — used at session-create time. Token freshness is maintained by
 * the background accounts refresh monitor, and CLAUDE_CONFIG_DIR lets the CLI
 * fall back to its own refresh logic if needed.
 */
export function getAccountToken(configDir: string): string | null {
	const creds = readAccountCredentials(configDir);
	const token = creds?.claudeAiOauth?.accessToken;
	if (isRealAccountToken(token)) return token!;
	// Fallback: plaintext token cache
	try {
		const paths = storePathsFor(configDir);
		if (existsSync(paths.tokenCacheFile)) {
			const cached = readFileSync(paths.tokenCacheFile, "utf-8").trim();
			if (isRealAccountToken(cached)) return cached;
		}
	} catch {
		/* ignore */
	}
	return null;
}

/** True if the account has a token that is valid or refreshable. */
export function accountHasUsableToken(configDir: string): boolean {
	const creds = readAccountCredentials(configDir);
	const oauth = creds?.claudeAiOauth;
	if (!oauth || !isRealAccountToken(oauth.accessToken)) {
		return isRealAccountToken(getAccountToken(configDir));
	}
	const now = Date.now();
	if (oauth.expiresAt && oauth.expiresAt <= now) {
		// Expired but refreshable if a refresh token exists
		return !!oauth.refreshToken;
	}
	return true;
}

/**
 * Refresh an additional account's access token using its refresh token.
 * Writes the new credentials back to the same config dir.
 */
export async function refreshAccountToken(configDir: string): Promise<boolean> {
	const creds = readAccountCredentials(configDir);
	const refreshToken = creds?.claudeAiOauth?.refreshToken;
	if (!refreshToken) return false;

	try {
		const response = await fetch(OAUTH_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: OAUTH_CLIENT_ID,
			}),
		});
		if (!response.ok) return false;
		const data = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			error?: string;
		};
		if (data.error || !data.access_token) return false;

		const ttlMs = data.expires_in
			? data.expires_in * 1000
			: 365 * 24 * 60 * 60 * 1000;
		writeAccountCredentials(
			configDir,
			data.access_token,
			data.refresh_token || refreshToken,
			creds?.accountInfo,
			Date.now() + ttlMs,
		);
		return true;
	} catch {
		return false;
	}
}

/** Milliseconds until the account token expires, or null if unknown. */
export function accountTokenTimeUntilExpiry(configDir: string): number | null {
	const creds = readAccountCredentials(configDir);
	const expiresAt = creds?.claudeAiOauth?.expiresAt;
	if (!expiresAt) return null;
	return expiresAt - Date.now();
}
