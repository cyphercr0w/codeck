/**
 * GitHub CLI authentication: login, token management, credential helpers.
 */
import { spawn, spawnSync, execFile } from "child_process";
import {
	existsSync,
	writeFileSync,
	unlinkSync,
	mkdirSync,
	copyFileSync,
} from "fs";
import { join } from "path";

// ── Credential persistence ──────────────────────────────────────────
// gh CLI stores tokens in ~/.config/gh/hosts.yml which is inside the container.
// On rebuild, this is lost. We backup to /workspace/.codeck/ (persistent volume)
// and restore at startup.
const GH_CONFIG_DIR = join(process.env.HOME || "/root", ".config", "gh");
const GH_HOSTS_FILE = join(GH_CONFIG_DIR, "hosts.yml");
const BACKUP_DIR = join(
	process.env.CODECK_DIR || "/workspace/.codeck",
	"github",
);
const BACKUP_HOSTS = join(BACKUP_DIR, "hosts.yml");

function backupGhCredentials(): void {
	try {
		if (!existsSync(GH_HOSTS_FILE)) return;
		if (!existsSync(BACKUP_DIR))
			mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
		copyFileSync(GH_HOSTS_FILE, BACKUP_HOSTS);
		console.log("[GitHub] Credentials backed up to workspace");
	} catch (e) {
		console.warn("[GitHub] Credential backup failed:", (e as Error).message);
	}
}

function restoreGhCredentials(): boolean {
	try {
		if (!existsSync(BACKUP_HOSTS)) return false;
		if (existsSync(GH_HOSTS_FILE)) return false; // already has credentials
		if (!existsSync(GH_CONFIG_DIR))
			mkdirSync(GH_CONFIG_DIR, { recursive: true, mode: 0o700 });
		copyFileSync(BACKUP_HOSTS, GH_HOSTS_FILE);
		console.log("[GitHub] Credentials restored from workspace backup");
		return true;
	} catch (e) {
		console.warn("[GitHub] Credential restore failed:", (e as Error).message);
		return false;
	}
}

// ── Shared mutable state ─────────────────────────────────────────────
export interface GitHubConfig {
	mode: "full" | "repo" | null;
	repoUrl: string | null;
	repoToken: string | null;
	authenticated: boolean;
	username: string | null;
	email: string | null;
	avatarUrl: string | null;
}

export const gitHubConfig: GitHubConfig = {
	mode: null,
	repoUrl: null,
	repoToken: null,
	authenticated: false,
	username: null,
	email: null,
	avatarUrl: null,
};

// ── gh CLI detection ─────────────────────────────────────────────────
let ghInstalled: boolean | null = null;

export function isGhInstalled(): boolean {
	if (ghInstalled !== null) return ghInstalled;
	const result = spawnSync("gh", ["--version"], {
		stdio: "pipe",
		timeout: 5000,
	});
	ghInstalled = result.status === 0;
	return ghInstalled;
}

// ── gh auth cache ────────────────────────────────────────────────────
let ghAuthCache: { result: boolean; checked: boolean; checking: boolean } = {
	result: false,
	checked: false,
	checking: false,
};

/**
 * Check if authenticated with GitHub (gh auth status).
 * Cached permanently — spawnSync blocks the event loop for up to 10s and
 * getGitStatus() is called from broadcastStatus() every 15s via the auth
 * monitor. Only re-checked at startup and after explicit login/logout.
 */
export function isGhAuthenticated(): boolean {
	if (!ghAuthCache.checked && !ghAuthCache.checking) {
		// Run async — don't block the event loop
		ghAuthCache.checking = true;
		execFile("gh", ["auth", "status"], { timeout: 5000 }, (err: any) => {
			ghAuthCache = { result: !err, checked: true, checking: false };
		});
	}
	return ghAuthCache.result;
}

export function invalidateGhAuthCache(): void {
	ghAuthCache = { result: false, checked: false, checking: false };
}

// ── Account info ─────────────────────────────────────────────────────
/**
 * Load GitHub account info (username, email, avatar) via gh api.
 * Called after successful login and at startup restore.
 */
function loadGitHubAccountInfo(): void {
	try {
		const result = spawnSync(
			"gh",
			["api", "user", "--jq", ".login,.email,.avatar_url"],
			{
				stdio: "pipe",
				timeout: 10000,
			},
		);
		if (result.status === 0) {
			const lines = result.stdout.toString().trim().split("\n");
			gitHubConfig.username = lines[0] || null;
			gitHubConfig.email = lines[1] && lines[1] !== "null" ? lines[1] : null;
			gitHubConfig.avatarUrl = lines[2] || null;
			console.log(`[GitHub] Account info loaded: @${gitHubConfig.username}`);
		}
	} catch (err) {
		console.warn(
			"[GitHub] Failed to load account info:",
			(err as Error).message,
		);
	}
}

// ── Init ─────────────────────────────────────────────────────────────
/**
 * Initialize GitHub state at server startup.
 * If gh CLI is authenticated (token persisted via volume), restore state and load account info.
 */
export function initGitHub(): void {
	if (!isGhInstalled()) return;

	// Restore credentials from workspace backup (survives container rebuild)
	restoreGhCredentials();

	// At startup, do a synchronous check (acceptable — only runs once)
	const startupResult = spawnSync("gh", ["auth", "status"], {
		stdio: "pipe",
		timeout: 5000,
	});
	ghAuthCache = {
		result: startupResult.status === 0,
		checked: true,
		checking: false,
	};
	if (ghAuthCache.result) {
		gitHubConfig.authenticated = true;
		gitHubConfig.mode = "full";
		loadGitHubAccountInfo();
		// Setup git credential helper in case it was lost on rebuild
		spawnSync("gh", ["auth", "setup-git"], { stdio: "pipe", timeout: 5000 });
		console.log("[GitHub] Session restored from persisted token");
	}
}

// ── Login ────────────────────────────────────────────────────────────
/**
 * Configure full GitHub access (gh auth login)
 */
export function startGitHubFullLogin(
	callbacks: {
		onCode?: (code: string) => void;
		onUrl?: (url: string) => void;
		onSuccess?: () => void;
		onError?: () => void;
	} = {},
): Promise<boolean> {
	return new Promise((resolve) => {
		console.log("\n🔐 Starting full GitHub login...\n");

		gitHubConfig.mode = "full";

		let proc;
		try {
			proc = spawn("gh", ["auth", "login", "--web", "-h", "github.com"], {
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			console.log(
				"\n❌ gh CLI not installed — cannot authenticate with GitHub\n",
			);
			if (callbacks.onError) callbacks.onError();
			return resolve(false);
		}

		let output = "";

		proc.on("error", (err: Error) => {
			console.log(`\n❌ gh CLI not available: ${err.message}\n`);
			if (callbacks.onError) callbacks.onError();
			resolve(false);
		});

		proc.stdout.on("data", (data: Buffer) => {
			const text = data.toString();
			output += text;
			console.log(text);

			// Capture verification code
			const codeMatch = text.match(/([A-Z0-9]{4}-[A-Z0-9]{4})/);
			if (codeMatch && callbacks.onCode) {
				callbacks.onCode(codeMatch[1]);
			}

			// Capture URL
			const urlMatch = text.match(/(https:\/\/github\.com\/login\/device)/);
			if (urlMatch && callbacks.onUrl) {
				callbacks.onUrl(urlMatch[1]);
			}
		});

		proc.stderr.on("data", (data: Buffer) => {
			const text = data.toString();
			output += text;
			console.log(text);

			// gh sometimes sends info to stderr
			const codeMatch = text.match(/([A-Z0-9]{4}-[A-Z0-9]{4})/);
			if (codeMatch && callbacks.onCode) {
				callbacks.onCode(codeMatch[1]);
			}
		});

		proc.on("close", (code) => {
			if (code === 0) {
				gitHubConfig.authenticated = true;
				invalidateGhAuthCache();
				loadGitHubAccountInfo();
				// Configure git to use gh as credential helper so shell sessions can clone
				spawnSync("gh", ["auth", "setup-git"], {
					stdio: "pipe",
					timeout: 5000,
				});
				// Backup credentials to persistent workspace volume
				backupGhCredentials();
				console.log(
					"\n✓ GitHub authenticated successfully (git credential helper configured)\n",
				);
				if (callbacks.onSuccess) callbacks.onSuccess();
				resolve(true);
			} else {
				console.log("\n❌ GitHub authentication error\n");
				if (callbacks.onError) callbacks.onError();
				resolve(false);
			}
		});
	});
}

// ── Token check ──────────────────────────────────────────────────────
/**
 * Check if a GitHub token is configured (env or repo-specific)
 */
export function hasGitHubToken(): boolean {
	return !!process.env.GITHUB_TOKEN || !!gitHubConfig.repoToken;
}

// ── Config getter ────────────────────────────────────────────────────
/**
 * Get current GitHub configuration
 */
export function getGitHubConfig() {
	return {
		mode: gitHubConfig.mode,
		repoUrl: gitHubConfig.repoUrl,
		authenticated: gitHubConfig.authenticated || isGhAuthenticated(),
		hasToken: !!gitHubConfig.repoToken || !!process.env.GITHUB_TOKEN,
	};
}

// ── Credential helpers ───────────────────────────────────────────────
/**
 * Configure git credentials using GIT_ASKPASS (no plaintext credentials on disk).
 * Creates a persistent askpass script that reads the token from a secured file.
 * This avoids writing tokens to ~/.git-credentials which persists across sessions.
 */
export function configureGitCredentials(_url: string, token: string): void {
	try {
		const home = process.env.HOME || "/root";
		const askpassDir = join(home, ".codeck-git");
		if (!existsSync(askpassDir))
			mkdirSync(askpassDir, { recursive: true, mode: 0o700 });

		const tokenPath = join(askpassDir, "token");
		const scriptPath = join(askpassDir, "askpass.sh");

		writeFileSync(tokenPath, token, { mode: 0o600 });
		writeFileSync(scriptPath, `#!/bin/sh\ncat "${tokenPath}"\n`, {
			mode: 0o700,
		});

		// Configure global askpass — avoids writing token to ~/.git-credentials
		spawnSync("git", ["config", "--global", "credential.helper", ""], {
			stdio: "pipe",
		});
		spawnSync("git", ["config", "--global", "core.askPass", scriptPath], {
			stdio: "pipe",
		});

		// Remove legacy ~/.git-credentials if it exists
		const legacyCredentials = join(home, ".git-credentials");
		if (existsSync(legacyCredentials)) {
			try {
				unlinkSync(legacyCredentials);
			} catch {
				/* best effort */
			}
			console.log("[Git] Removed legacy ~/.git-credentials");
		}

		console.log("✓ Git credentials configured (via askpass)\n");
	} catch (err) {
		console.error("Error configuring credentials:", (err as Error).message);
	}
}
