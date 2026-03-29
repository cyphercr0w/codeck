/**
 * Credential persistence — symlinks ephemeral config dirs to /workspace/.codeck/credentials/.
 *
 * Runs at runtime startup (before auth checks) to restore credential symlinks
 * that were lost during container rebuild.
 *
 * Uses readFileSync/writeFileSync (content-only copy) instead of cpSync to avoid
 * EPERM errors when files are owned by a different UID (e.g. uid=999 from gh CLI).
 */

import {
	existsSync,
	mkdirSync,
	symlinkSync,
	lstatSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
	renameSync,
} from "fs";
import { dirname, join } from "path";

const PERSIST_DIR = "/workspace/.codeck/credentials";

// /root/.claude.json is a single file outside the Docker volume.
// CLAUDE_JSON_SYSTEM: ephemeral path used by Claude Code at runtime.
// CLAUDE_JSON_PERSIST: durable backup inside the /workspace volume.
const CLAUDE_JSON_SYSTEM = "/root/.claude.json";
const CLAUDE_JSON_PERSIST = join(PERSIST_DIR, "claude-config.json");

const CREDENTIAL_PATHS: Record<string, string> = {
	gh: "/root/.config/gh",
	ssh: "/root/.ssh",
	claude: "/root/.claude",
	vercel: "/root/.local/share/com.vercel.cli",
	vercel2: "/root/.vercel",
	npm: "/root/.npmrc",
	docker: "/root/.docker",
	aws: "/root/.aws",
	gcloud: "/root/.config/gcloud",
	azure: "/root/.azure",
	stripe: "/root/.config/stripe",
	supabase: "/root/.config/supabase",
	fly: "/root/.fly",
	railway: "/root/.config/railway",
	netlify: "/root/.config/netlify",
	heroku: "/root/.netrc",
};

/**
 * Content-only recursive copy. Uses readFileSync/writeFileSync to avoid EPERM
 * when source files are owned by a different UID (e.g. uid=999 from gh CLI).
 * Does NOT preserve ownership or permissions — writes as current user (root).
 */
function safeCopyRecursive(src: string, dest: string): void {
	const stat = lstatSync(src);
	if (stat.isDirectory()) {
		if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
		for (const entry of readdirSync(src)) {
			safeCopyRecursive(join(src, entry), join(dest, entry));
		}
	} else if (stat.isFile()) {
		const parentDir = dirname(dest);
		if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
		writeFileSync(dest, readFileSync(src));
	}
	// Skip symlinks and special files inside credential dirs
}

/**
 * Restore credential symlinks from persistent storage.
 * Call this at runtime startup, BEFORE any auth checks.
 */
export function restoreCredentialSymlinks(): void {
	if (!existsSync(PERSIST_DIR)) {
		mkdirSync(PERSIST_DIR, { recursive: true, mode: 0o700 });
	}

	let restored = 0;
	let migrated = 0;

	for (const [name, systemPath] of Object.entries(CREDENTIAL_PATHS)) {
		const persistPath = join(PERSIST_DIR, name);

		try {
			const sysLstat = existsSync(systemPath)
				? lstatSync(systemPath, { throwIfNoEntry: false })
				: null;

			// Already a symlink → nothing to do
			if (sysLstat?.isSymbolicLink()) continue;

			// Case 1: real data at system path, no persistent copy → migrate
			if (sysLstat && !existsSync(persistPath)) {
				safeCopyRecursive(systemPath, persistPath);
				try {
					rmSync(systemPath, { recursive: true, force: true });
					symlinkSync(persistPath, systemPath);
					migrated++;
				} catch {
					// Can't replace (busy mount) — data is at least persisted now
				}
				continue;
			}

			// Case 2: persistent copy exists, system path gone (post-rebuild) → restore
			if (existsSync(persistPath) && !sysLstat) {
				const parentDir = dirname(systemPath);
				if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
				try {
					symlinkSync(persistPath, systemPath);
				} catch {
					// Symlink failed — fall back to copying files
					safeCopyRecursive(persistPath, systemPath);
				}
				restored++;
				continue;
			}

			// Case 3: both exist, system is real (not symlink) → replace with symlink
			if (existsSync(persistPath) && sysLstat && !sysLstat.isSymbolicLink()) {
				// Update persistent copy first (system may have newer data)
				safeCopyRecursive(systemPath, persistPath);
				try {
					const backupPath = systemPath + ".bak";
					try {
						renameSync(systemPath, backupPath);
					} catch {
						rmSync(systemPath, { recursive: true, force: true });
					}
					symlinkSync(persistPath, systemPath);
					migrated++;
				} catch {
					// Directory can't be removed (busy mount) — copy from persist into it
					safeCopyRecursive(persistPath, systemPath);
					restored++;
				}
			}
		} catch (err) {
			console.warn(`[CredentialPersist] ${name}: ${(err as Error).message}`);
		}
	}

	if (restored + migrated > 0) {
		console.log(
			`[CredentialPersist] ${restored} restored, ${migrated} migrated`,
		);
	}

	// Special case: /root/.claude.json is a file (not a dir) outside the Docker volume.
	// Copy to/from persistent storage on every startup so it survives container rebuilds.
	persistClaudeJson();
}

/**
 * Persist /root/.claude.json across container rebuilds.
 * Called once at startup from restoreCredentialSymlinks().
 */
function persistClaudeJson(): void {
	const systemExists = existsSync(CLAUDE_JSON_SYSTEM);
	const persistExists = existsSync(CLAUDE_JSON_PERSIST);

	try {
		if (systemExists && !persistExists) {
			writeFileSync(CLAUDE_JSON_PERSIST, readFileSync(CLAUDE_JSON_SYSTEM), {
				mode: 0o600,
			});
			console.log(
				"[CredentialPersist] claude.json: migrated to persistent storage",
			);
		} else if (persistExists && !systemExists) {
			writeFileSync(CLAUDE_JSON_SYSTEM, readFileSync(CLAUDE_JSON_PERSIST), {
				mode: 0o600,
			});
			console.log(
				"[CredentialPersist] claude.json: restored from persistent storage",
			);
		} else if (systemExists && persistExists) {
			writeFileSync(CLAUDE_JSON_PERSIST, readFileSync(CLAUDE_JSON_SYSTEM), {
				mode: 0o600,
			});
		}
	} catch (err) {
		console.warn(`[CredentialPersist] claude.json: ${(err as Error).message}`);
	}
}

/**
 * Backup /root/.claude.json to persistent storage.
 * Call after any MCP server mutation (POST, DELETE, toggle).
 */
export function backupClaudeConfig(): void {
	try {
		if (existsSync(CLAUDE_JSON_SYSTEM)) {
			writeFileSync(CLAUDE_JSON_PERSIST, readFileSync(CLAUDE_JSON_SYSTEM), {
				mode: 0o600,
			});
		}
	} catch {
		/* best effort */
	}
}
