/**
 * Multi-account registry and per-account session wiring.
 *
 * The DEFAULT (first) account keeps the legacy layout at ~/.claude and never
 * sets CLAUDE_CONFIG_DIR. ADDITIONAL accounts live in isolated config dirs under
 * /workspace/.codeck/accounts/<uuid>/ and run with CLAUDE_CONFIG_DIR set, so two
 * accounts can run concurrent sessions without colliding on credentials,
 * history or token refresh.
 *
 * The registry (accounts.json) holds only metadata — credentials stay inside
 * each account's config dir (see auth-anthropic/account-store.ts).
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { ACTIVE_AGENT } from "./agent.js";
import { CODECK_DIR } from "./auth-anthropic/encryption.js";
import { atomicWriteFileSync } from "./memory.js";
import { ensureOnboardingComplete, getOAuthEnv } from "./claude-env.js";
import { syncToClaudeSettings } from "./permissions.js";
import {
	getAccountInfo,
	isClaudeAuthenticated,
	logoutClaude,
	saveOAuthToken,
} from "./auth-anthropic.js";
import {
	writeAccountCredentials,
	getAccountToken,
	accountHasUsableToken,
	refreshAccountToken,
	accountTokenTimeUntilExpiry,
	readAccountInfo,
} from "./auth-anthropic/account-store.js";
import type { AccountInfo } from "./auth-anthropic/encryption.js";

// ============ Types ============

export interface AccountMeta {
	uuid: string;
	email: string | null;
	organizationName: string | null;
	organizationUuid: string | null;
	label: string;
	configDir: string;
	isDefault: boolean;
	addedAt: number;
}

interface Registry {
	version: number;
	accounts: AccountMeta[];
}

export interface AccountPaths {
	configDir: string;
	credentialsFile: string;
	configFile: string;
	settingsFile: string;
	projectsDir: string;
	setConfigDirEnv: boolean;
}

/** Public, token-free view of an account for API/WS payloads. */
export interface PublicAccount {
	uuid: string;
	email: string | null;
	organizationName: string | null;
	label: string;
	isDefault: boolean;
	hasToken: boolean;
}

// ============ Paths ============

const REGISTRY_PATH = join(CODECK_DIR, "accounts.json");
const ACCOUNTS_DIR = join(CODECK_DIR, "accounts");

// ============ Registry I/O ============

function loadRegistry(): Registry {
	try {
		if (existsSync(REGISTRY_PATH)) {
			const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
			if (Array.isArray(raw.accounts)) {
				return { version: raw.version || 1, accounts: raw.accounts };
			}
		}
	} catch (e) {
		console.warn("[Accounts] Failed to read registry:", (e as Error).message);
	}
	return { version: 1, accounts: [] };
}

function saveRegistry(reg: Registry): void {
	if (!existsSync(CODECK_DIR)) mkdirSync(CODECK_DIR, { recursive: true, mode: 0o700 });
	atomicWriteFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), {
		mode: 0o600,
	});
}

// ============ Default account fallback ============

/** Build the implicit default account from the legacy ~/.claude layout. */
function defaultAccountMeta(): AccountMeta {
	const info = (() => {
		try {
			return getAccountInfo();
		} catch {
			return null;
		}
	})();
	return {
		uuid: info?.accountUuid || "default",
		email: info?.email || null,
		organizationName: info?.organizationName || null,
		organizationUuid: info?.organizationUuid || null,
		label: info?.email || info?.organizationName || "Default account",
		configDir: ACTIVE_AGENT.configDir,
		isDefault: true,
		addedAt: 0,
	};
}

// ============ Queries ============

export function listAccounts(): AccountMeta[] {
	const reg = loadRegistry();
	if (reg.accounts.length === 0) {
		// No registry yet — surface the legacy account if one is connected
		return isClaudeAuthenticated() ? [defaultAccountMeta()] : [];
	}
	return reg.accounts;
}

export function getAccount(uuid: string): AccountMeta | undefined {
	return listAccounts().find((a) => a.uuid === uuid);
}

export function getDefaultAccount(): AccountMeta | undefined {
	const accounts = listAccounts();
	return accounts.find((a) => a.isDefault) || accounts[0];
}

export function getDefaultAccountUuid(): string | null {
	return getDefaultAccount()?.uuid ?? null;
}

/** Resolve which account a session should use; falls back to the default. */
export function resolveAccountForSession(uuid?: string): AccountMeta {
	if (uuid) {
		const found = getAccount(uuid);
		if (found) return found;
	}
	return getDefaultAccount() || defaultAccountMeta();
}

export function getAccountPaths(account: AccountMeta): AccountPaths {
	const isDefault = account.configDir === ACTIVE_AGENT.configDir;
	const dir = account.configDir;
	return {
		configDir: dir,
		credentialsFile: isDefault
			? ACTIVE_AGENT.credentialsFile
			: join(dir, ".credentials.json"),
		configFile: isDefault ? ACTIVE_AGENT.configFile : join(dir, ".claude.json"),
		settingsFile: isDefault
			? ACTIVE_AGENT.settingsFile
			: join(dir, "settings.json"),
		projectsDir: isDefault ? ACTIVE_AGENT.projectsDir : join(dir, "projects"),
		setConfigDirEnv: !isDefault,
	};
}

/** Does the account have a valid/refreshable token? */
export function hasValidToken(account: AccountMeta): boolean {
	if (account.configDir === ACTIVE_AGENT.configDir) {
		return isClaudeAuthenticated();
	}
	return accountHasUsableToken(account.configDir);
}

export function listPublicAccounts(): PublicAccount[] {
	return listAccounts().map((a) => ({
		uuid: a.uuid,
		email: a.email,
		organizationName: a.organizationName,
		label: a.label,
		isDefault: a.isDefault,
		hasToken: hasValidToken(a),
	}));
}

// ============ Session env / config dir ============

/**
 * Environment for a PTY session running under this account.
 * Default account → existing OAuth env (no CLAUDE_CONFIG_DIR).
 * Additional account → CLAUDE_CONFIG_DIR (+ token when available).
 */
export function getAccountSessionEnv(
	account: AccountMeta,
): Record<string, string> {
	if (account.configDir === ACTIVE_AGENT.configDir) {
		return getOAuthEnv();
	}
	const env: Record<string, string> = { CLAUDE_CONFIG_DIR: account.configDir };
	const token = getAccountToken(account.configDir);
	if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
	return env;
}

/** Ensure an account's config dir exists and has onboarding + permissions. */
export function prepareAccountConfigDir(account: AccountMeta): void {
	const paths = getAccountPaths(account);
	if (paths.setConfigDirEnv) {
		if (!existsSync(paths.configDir)) {
			mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
		}
		if (!existsSync(paths.projectsDir)) {
			mkdirSync(paths.projectsDir, { recursive: true, mode: 0o700 });
		}
	}
	ensureOnboardingComplete(paths.configFile);
	syncToClaudeSettings(paths.settingsFile);
}

// ============ Registry mutations ============

export function renameAccount(uuid: string, label: string): boolean {
	const reg = loadRegistry();
	const acct = reg.accounts.find((a) => a.uuid === uuid);
	if (!acct) return false;
	acct.label = label.slice(0, 80);
	saveRegistry(reg);
	return true;
}

export function setDefaultAccount(uuid: string): boolean {
	const reg = loadRegistry();
	if (!reg.accounts.some((a) => a.uuid === uuid)) return false;
	for (const a of reg.accounts) a.isDefault = a.uuid === uuid;
	saveRegistry(reg);
	return true;
}

/**
 * Remove an account. Additional accounts delete their config dir; removing the
 * default account also clears the legacy ~/.claude credentials (full logout).
 * Promotes another account to default when one remains.
 */
export function removeAccount(uuid: string): boolean {
	const reg = loadRegistry();
	const idx = reg.accounts.findIndex((a) => a.uuid === uuid);
	if (idx === -1) return false;
	const acct = reg.accounts[idx];
	const wasDefault = acct.isDefault;

	if (acct.configDir === ACTIVE_AGENT.configDir) {
		// Default/legacy account — clear its credentials
		try {
			logoutClaude();
		} catch {
			/* non-fatal */
		}
	} else {
		// Additional account — delete its isolated config dir
		try {
			rmSync(acct.configDir, { recursive: true, force: true });
		} catch (e) {
			console.warn(
				"[Accounts] Failed to delete config dir:",
				(e as Error).message,
			);
		}
	}

	reg.accounts.splice(idx, 1);
	if (wasDefault && reg.accounts.length > 0) {
		reg.accounts[0].isDefault = true;
	}
	saveRegistry(reg);
	return true;
}

/**
 * Add or update an account after a successful OAuth exchange.
 * - Same uuid already present → re-login (rewrites that account's credentials).
 * - New uuid → create an isolated config dir and register it.
 */
export function addOrUpdateAccountFromExchange(
	token: string,
	refreshToken: string,
	accountInfo: AccountInfo,
	expiresIn?: number,
): AccountMeta {
	ensureMigrated();
	const reg = loadRegistry();
	const uuid = accountInfo.accountUuid || `acct-${Date.now()}`;
	const ttlMs = expiresIn ? expiresIn * 1000 : 365 * 24 * 60 * 60 * 1000;
	const expiresAt = Date.now() + ttlMs;

	const existing = reg.accounts.find((a) => a.uuid === uuid);
	if (existing) {
		// Re-login of an existing account
		if (existing.configDir === ACTIVE_AGENT.configDir) {
			// Default account is written via the legacy saveOAuthToken path by the
			// caller — here we only refresh its metadata.
		} else {
			writeAccountCredentials(
				existing.configDir,
				token,
				refreshToken,
				accountInfo,
				expiresAt,
			);
		}
		existing.email = accountInfo.email ?? existing.email;
		existing.organizationName =
			accountInfo.organizationName ?? existing.organizationName;
		existing.organizationUuid =
			accountInfo.organizationUuid ?? existing.organizationUuid;
		saveRegistry(reg);
		return existing;
	}

	// Brand-new account — isolated config dir
	const configDir = join(ACCOUNTS_DIR, uuid);
	writeAccountCredentials(configDir, token, refreshToken, accountInfo, expiresAt);

	const meta: AccountMeta = {
		uuid,
		email: accountInfo.email,
		organizationName: accountInfo.organizationName,
		organizationUuid: accountInfo.organizationUuid,
		label: accountInfo.email || accountInfo.organizationName || "Claude account",
		configDir,
		isDefault: reg.accounts.length === 0,
		addedAt: Date.now(),
	};
	reg.accounts.push(meta);
	saveRegistry(reg);

	try {
		prepareAccountConfigDir(meta);
	} catch (e) {
		console.warn(
			"[Accounts] prepareAccountConfigDir failed:",
			(e as Error).message,
		);
	}
	console.log(
		`[Accounts] Added account ${meta.label} (${uuid.slice(0, 8)}) at ${configDir}`,
	);
	return meta;
}

/**
 * Persist a freshly-exchanged login into the right place:
 * a re-login of the default/legacy account writes to ~/.claude via the legacy
 * path; any other account goes into an isolated config dir.
 */
export function completeAccountLogin(
	token: string,
	refreshToken: string,
	accountInfo: AccountInfo,
	expiresIn?: number,
): AccountMeta {
	ensureMigrated();
	const uuid = accountInfo.accountUuid || "";
	const def = getDefaultAccount();
	const isDefaultRelogin =
		!!def &&
		def.configDir === ACTIVE_AGENT.configDir &&
		!!uuid &&
		(def.uuid === uuid || def.uuid === "default");

	if (isDefaultRelogin) {
		saveOAuthToken(token, refreshToken, accountInfo, expiresIn);
		const reg = loadRegistry();
		const d =
			reg.accounts.find((a) => a.isDefault) ||
			reg.accounts.find((a) => a.configDir === ACTIVE_AGENT.configDir);
		if (d) {
			d.uuid = uuid;
			d.email = accountInfo.email ?? d.email;
			d.organizationName = accountInfo.organizationName ?? d.organizationName;
			d.organizationUuid = accountInfo.organizationUuid ?? d.organizationUuid;
			if (!d.label || d.label === "Default account") {
				d.label = accountInfo.email || accountInfo.organizationName || d.label;
			}
			saveRegistry(reg);
			return d;
		}
		return defaultAccountMeta();
	}

	return addOrUpdateAccountFromExchange(
		token,
		refreshToken,
		accountInfo,
		expiresIn,
	);
}

// ============ Migration ============

let migrated = false;

/**
 * One-time migration: if no registry exists yet but a Claude account is already
 * connected at ~/.claude, register it as the default account. Non-destructive.
 */
export function ensureMigrated(): void {
	if (migrated) return;
	const reg = loadRegistry();
	if (reg.accounts.length > 0) {
		migrated = true;
		return;
	}
	if (!isClaudeAuthenticated()) {
		// Nothing connected yet — first login will seed the registry
		return;
	}
	const meta = defaultAccountMeta();
	reg.accounts.push(meta);
	saveRegistry(reg);
	migrated = true;
	console.log(
		`[Accounts] Migrated existing account ${meta.label} as default (${meta.uuid.slice(0, 8)})`,
	);
}

export function migrateExistingAccountIfNeeded(): void {
	try {
		ensureMigrated();
	} catch (e) {
		console.warn("[Accounts] Migration failed:", (e as Error).message);
	}
}

// ============ Background refresh monitor ============

const REFRESH_CHECK_MS = 5 * 60 * 1000;
const REFRESH_MARGIN_MS = 30 * 60 * 1000;
let accountsRefreshInterval: ReturnType<typeof setInterval> | null = null;

export function startAccountsRefreshMonitor(): void {
	if (accountsRefreshInterval) return;
	console.log("[Accounts] Starting multi-account token refresh monitor (5min)");
	accountsRefreshInterval = setInterval(async () => {
		const reg = loadRegistry();
		for (const acct of reg.accounts) {
			// Default account is handled by the legacy token-manager monitor
			if (acct.configDir === ACTIVE_AGENT.configDir) continue;
			const timeLeft = accountTokenTimeUntilExpiry(acct.configDir);
			if (timeLeft === null) continue;
			if (timeLeft <= REFRESH_MARGIN_MS) {
				const ok = await refreshAccountToken(acct.configDir);
				if (ok) {
					console.log(
						`[Accounts] Refreshed token for ${acct.label} (${acct.uuid.slice(0, 8)})`,
					);
					// Refresh cached metadata in case it changed
					const info = readAccountInfo(acct.configDir);
					if (info) {
						acct.email = info.email ?? acct.email;
						acct.organizationName =
							info.organizationName ?? acct.organizationName;
					}
				}
			}
		}
		saveRegistry(reg);
	}, REFRESH_CHECK_MS);
}

export function stopAccountsRefreshMonitor(): void {
	if (accountsRefreshInterval) {
		clearInterval(accountsRefreshInterval);
		accountsRefreshInterval = null;
	}
}
