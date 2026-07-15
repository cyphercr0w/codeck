import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	readdirSync,
	copyFileSync,
	realpathSync,
	statSync,
	renameSync,
	rmSync,
} from "fs";
import { execFileSync } from "child_process";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.WORKSPACE || "/workspace";
const WORKSPACE_CODECK = join(WORKSPACE, ".codeck");
const CONFIG_FILE = join(WORKSPACE_CODECK, "config.json");
const TEMPLATES_DIR = resolve(join(__dirname, "../templates/presets"));
const BACKUPS_DIR = join(WORKSPACE_CODECK, "backups");

// Strict allowlist for preset IDs: alphanumeric, hyphens, underscores only
const VALID_PRESET_ID = /^[a-zA-Z0-9_-]+$/;

const home = process.env.HOME || "/root";

// Allowed destination path prefixes for manifest files
const ALLOWED_DEST_PREFIXES = [`${WORKSPACE}/`, `${home}/.claude/`, `${home}/`];

/**
 * Rewrite manifest paths from Docker defaults (/root/, /workspace/) to
 * the actual runtime paths. This allows a single manifest.json to work
 * across Docker, systemd, and cli-local deployment modes.
 */
function rewritePath(p: string): string {
	if (p.startsWith("/root/")) {
		return `${home}/${p.slice("/root/".length)}`;
	}
	if (p.startsWith("/workspace/")) {
		return `${WORKSPACE}/${p.slice("/workspace/".length)}`;
	}
	if (p === "/workspace") {
		return WORKSPACE;
	}
	return p;
}

// ── Types ────────────────────────────────────────────────────────────

export interface RecursiveDirEntry {
	src: string;
	dest: string;
	recursive: boolean;
	skipIfExists: boolean;
}

export interface PresetManifest {
	id: string;
	name: string;
	description: string;
	version: string;
	author: string;
	icon: string;
	tags: string[];
	extends: string | null;
	files: Array<{ src: string; dest: string; skipIfExists?: boolean }>;
	directories: string[];
	recursive_dirs?: RecursiveDirEntry[];
}

interface PresetConfig {
	presetId: string;
	presetName: string;
	configuredAt: string;
	version: string;
	autoUpdate?: boolean;
}

export interface PresetStatus {
	configured: boolean;
	presetId: string | null;
	presetName: string | null;
	configuredAt: string | null;
	version: string | null;
	availableVersion: string | null;
	updateAvailable: boolean;
	autoUpdate: boolean;
}

export interface PresetOverrides {
	hooks: { disabled: string[] };
	skills: { disabled: string[] };
	agents: { disabled: string[] };
	mcpServers: { disabled: string[] };
}

const OVERRIDES_FILE = join(WORKSPACE_CODECK, "preset-overrides.json");

const DEFAULT_OVERRIDES: PresetOverrides = {
	hooks: { disabled: [] },
	skills: { disabled: [] },
	agents: { disabled: [] },
	mcpServers: { disabled: [] },
};

export function readOverrides(): PresetOverrides {
	try {
		if (!existsSync(OVERRIDES_FILE))
			return {
				...DEFAULT_OVERRIDES,
				hooks: { disabled: [] },
				skills: { disabled: [] },
				agents: { disabled: [] },
				mcpServers: { disabled: [] },
			};
		const raw = JSON.parse(readFileSync(OVERRIDES_FILE, "utf-8"));
		return {
			hooks: {
				disabled: Array.isArray(raw?.hooks?.disabled) ? raw.hooks.disabled : [],
			},
			skills: {
				disabled: Array.isArray(raw?.skills?.disabled)
					? raw.skills.disabled
					: [],
			},
			agents: {
				disabled: Array.isArray(raw?.agents?.disabled)
					? raw.agents.disabled
					: [],
			},
			mcpServers: {
				disabled: Array.isArray(raw?.mcpServers?.disabled)
					? raw.mcpServers.disabled
					: [],
			},
		};
	} catch {
		return {
			hooks: { disabled: [] },
			skills: { disabled: [] },
			agents: { disabled: [] },
			mcpServers: { disabled: [] },
		};
	}
}

export function writeOverrides(overrides: PresetOverrides): void {
	if (!existsSync(WORKSPACE_CODECK)) {
		mkdirSync(WORKSPACE_CODECK, { recursive: true, mode: 0o700 });
	}
	writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2), {
		mode: 0o600,
	});
}

/**
 * Apply preset overrides: remove disabled hooks from settings.json,
 * delete disabled skill dirs, delete disabled agent .md files,
 * and set disabled:true on disabled MCP servers in .claude.json.
 */
export function applyOverrides(overrides: PresetOverrides): void {
	const settingsPath = rewritePath("/root/.claude/settings.json");
	const claudeJsonPath = join(home, ".claude.json");
	const agentsDir = rewritePath("/root/.claude/agents");
	const skillsDir = rewritePath("/root/.claude/skills");

	// ── Hooks ──────────────────────────────────────────────────────────
	if (overrides.hooks.disabled.length > 0 && existsSync(settingsPath)) {
		try {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			if (settings.hooks && typeof settings.hooks === "object") {
				for (const event of Object.keys(settings.hooks)) {
					const entries = settings.hooks[event];
					if (!Array.isArray(entries)) continue;
					settings.hooks[event] = entries.filter(
						(entry: { hooks?: Array<{ command?: string }> }) => {
							const hooks = entry.hooks || [];
							return !hooks.some((h: { command?: string }) => {
								const cmd = h.command || "";
								return overrides.hooks.disabled.some((disabled) =>
									cmd.includes(disabled),
								);
							});
						},
					);
				}
				writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
				console.log(
					`[Preset] Applied hook overrides: ${overrides.hooks.disabled.join(", ")}`,
				);
			}
		} catch (e) {
			console.warn(
				"[Preset] Failed to apply hook overrides:",
				(e as Error).message,
			);
		}
	}

	// ── Skills ─────────────────────────────────────────────────────────
	for (const skillId of overrides.skills.disabled) {
		const skillDir = join(skillsDir, skillId);
		if (existsSync(skillDir)) {
			try {
				rmSync(skillDir, { recursive: true, force: true });
				console.log(`[Preset] Removed disabled skill: ${skillId}`);
			} catch (e) {
				console.warn(
					`[Preset] Failed to remove skill ${skillId}:`,
					(e as Error).message,
				);
			}
		}
	}

	// ── Agents ─────────────────────────────────────────────────────────
	for (const agentId of overrides.agents.disabled) {
		const agentFile = join(agentsDir, `${agentId}.md`);
		if (existsSync(agentFile)) {
			try {
				rmSync(agentFile, { force: true });
				console.log(`[Preset] Removed disabled agent: ${agentId}`);
			} catch (e) {
				console.warn(
					`[Preset] Failed to remove agent ${agentId}:`,
					(e as Error).message,
				);
			}
		}
	}

	// ── MCP Servers ────────────────────────────────────────────────────
	if (overrides.mcpServers.disabled.length > 0 && existsSync(claudeJsonPath)) {
		try {
			const claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
			if (claudeJson.mcpServers && typeof claudeJson.mcpServers === "object") {
				for (const name of overrides.mcpServers.disabled) {
					if (claudeJson.mcpServers[name]) {
						(claudeJson.mcpServers[name] as Record<string, unknown>).disabled =
							true;
					}
				}
				writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
				console.log(
					`[Preset] Applied MCP server overrides: ${overrides.mcpServers.disabled.join(", ")}`,
				);
			}
		} catch (e) {
			console.warn(
				"[Preset] Failed to apply MCP server overrides:",
				(e as Error).message,
			);
		}
	}
}

// ── Preset Contents (for API) ─────────────────────────────────────────────

export interface PresetContentItem {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
}

export interface PresetContents {
	hooks: PresetContentItem[];
	skills: PresetContentItem[];
	agents: PresetContentItem[];
	mcpServers: PresetContentItem[];
}

/** Parse YAML frontmatter between --- markers. Returns key-value pairs. */
function parseFrontmatter(content: string): Record<string, string> {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return {};
	const result: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const key = line.slice(0, colon).trim();
		const value = line
			.slice(colon + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		if (key) result[key] = value;
	}
	return result;
}

/** Extract hook name and description from first JSDoc comment in a script file. */
function parseHookJsDoc(content: string): {
	name: string;
	description: string;
} {
	const match = content.match(/\/\*\*([\s\S]*?)\*\//);
	if (!match) return { name: "", description: "" };
	const lines = match[1]
		.split("\n")
		.map((l) => l.replace(/^\s*\*\s?/, "").trim())
		.filter(Boolean);
	const name = lines[0] || "";
	const description = lines.slice(1).join(" ").trim();
	return { name, description };
}

/**
 * Read the default preset contents and cross-reference with current overrides.
 * Returns all hooks, skills, agents, and MCP servers with enabled/disabled status.
 */
export function getPresetContents(presetId = "default"): PresetContents {
	const overrides = readOverrides();
	const presetDir = join(TEMPLATES_DIR, presetId);

	// ── Hooks ──────────────────────────────────────────────────────────
	const hooks: PresetContentItem[] = [];
	const templateSettingsPath = join(presetDir, "ecc", "settings.json");
	if (existsSync(templateSettingsPath)) {
		try {
			const settings = JSON.parse(readFileSync(templateSettingsPath, "utf-8"));
			const scriptFilenames = new Set<string>();
			if (settings.hooks && typeof settings.hooks === "object") {
				for (const entries of Object.values(settings.hooks)) {
					if (!Array.isArray(entries)) continue;
					for (const entry of entries) {
						const hookList = (entry as Record<string, unknown>).hooks;
						if (!Array.isArray(hookList)) continue;
						for (const h of hookList) {
							const cmd = (h as Record<string, unknown>).command as
								| string
								| undefined;
							if (!cmd) continue;
							const match = cmd.match(
								/([^/\s]+\.mjs|[^/\s]+\.sh|[^/\s]+\.js)(?:\s|$)/,
							);
							if (match) scriptFilenames.add(match[1]);
						}
					}
				}
			}
			for (const filename of scriptFilenames) {
				const scriptPath = join(presetDir, "scripts", filename);
				let name = filename.replace(/\.(mjs|js|sh)$/, "").replace(/-/g, " ");
				let description = "";
				if (existsSync(scriptPath)) {
					const content = readFileSync(scriptPath, "utf-8");
					const parsed = parseHookJsDoc(content);
					if (parsed.name) name = parsed.name;
					if (parsed.description) description = parsed.description;
				}
				hooks.push({
					id: filename,
					name,
					description,
					enabled: !overrides.hooks.disabled.includes(filename),
				});
			}
		} catch (e) {
			console.warn(
				"[Preset] Failed to read hooks for contents:",
				(e as Error).message,
			);
		}
	}

	// ── Skills ─────────────────────────────────────────────────────────
	const skills: PresetContentItem[] = [];
	const skillsTemplatDir = join(presetDir, "ecc", "skills");
	if (existsSync(skillsTemplatDir)) {
		try {
			for (const entry of readdirSync(skillsTemplatDir)) {
				const skillMdPath = join(skillsTemplatDir, entry, "SKILL.md");
				if (!existsSync(skillMdPath)) continue;
				const content = readFileSync(skillMdPath, "utf-8");
				const fm = parseFrontmatter(content);
				skills.push({
					id: entry,
					name: fm.name || entry,
					description: fm.description || "",
					enabled: !overrides.skills.disabled.includes(entry),
				});
			}
		} catch (e) {
			console.warn(
				"[Preset] Failed to read skills for contents:",
				(e as Error).message,
			);
		}
	}

	// ── Agents ─────────────────────────────────────────────────────────
	const agents: PresetContentItem[] = [];
	const agentsTemplateDir = join(presetDir, "ecc", "agents");
	if (existsSync(agentsTemplateDir)) {
		try {
			for (const entry of readdirSync(agentsTemplateDir)) {
				if (!entry.endsWith(".md")) continue;
				const agentId = entry.replace(/\.md$/, "");
				const content = readFileSync(join(agentsTemplateDir, entry), "utf-8");
				const fm = parseFrontmatter(content);
				agents.push({
					id: agentId,
					name: fm.name || agentId,
					description: fm.description || "",
					enabled: !overrides.agents.disabled.includes(agentId),
				});
			}
		} catch (e) {
			console.warn(
				"[Preset] Failed to read agents for contents:",
				(e as Error).message,
			);
		}
	}

	// ── MCP Servers ────────────────────────────────────────────────────
	const mcpServers: PresetContentItem[] = [];
	const mcpTemplatePath = join(presetDir, "mcp.json");
	if (existsSync(mcpTemplatePath)) {
		try {
			const mcpTemplate = JSON.parse(readFileSync(mcpTemplatePath, "utf-8"));
			const allServers: Record<string, Record<string, unknown>> = {
				...(mcpTemplate.mcpServers || {}),
				...(mcpTemplate._disabledMcpServers || {}),
			};
			for (const [name, config] of Object.entries(allServers)) {
				const description = (config.description as string | undefined) || "";
				mcpServers.push({
					id: name,
					name,
					description,
					enabled: !overrides.mcpServers.disabled.includes(name),
				});
			}
		} catch (e) {
			console.warn(
				"[Preset] Failed to read MCP servers for contents:",
				(e as Error).message,
			);
		}
	}

	return { hooks, skills, agents, mcpServers };
}

// ── Startup Sanitization ────────────────────────────────────────────

/**
 * Remove ghost hooks from settings.json at runtime startup.
 * Ghost hooks are entries whose command is empty or not a valid executable
 * (e.g. plain text prompts injected by agents, npx commands, etc.).
 * Runs once at startup before any sessions are created.
 */
export function sanitizeSettingsHooks(): void {
	const settingsPath = rewritePath("/root/.claude/settings.json");
	try {
		if (!existsSync(settingsPath)) return;
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		if (!settings.hooks || typeof settings.hooks !== "object") return;

		let totalRemoved = 0;
		for (const event of Object.keys(settings.hooks)) {
			const entries = settings.hooks[event];
			if (!Array.isArray(entries)) continue;

			const before = entries.length;
			settings.hooks[event] = entries.filter(
				(entry: { hooks?: Array<{ command?: string }> }) => {
					const hooks = entry.hooks || [];
					if (hooks.length === 0) return false;
					return hooks.every((h: { command?: string }) => {
						const cmd = (h.command || "").trim();
						if (!cmd) return false;
						return (
							cmd.startsWith("node ") ||
							cmd.startsWith("bash ") ||
							cmd.startsWith("sh ") ||
							cmd.startsWith("python ") ||
							cmd.startsWith("python3 ") ||
							cmd.startsWith("/")
						);
					});
				},
			);
			totalRemoved += before - settings.hooks[event].length;
		}

		if (totalRemoved > 0) {
			writeFileSync(settingsPath, JSON.stringify(settings, null, "\t"));
			console.log(
				`[Preset] Sanitized settings.json: removed ${totalRemoved} ghost hook(s)`,
			);
		}
	} catch {
		/* non-fatal */
	}
}

// ── Validation ──────────────────────────────────────────────────────

/** Validate that a preset ID contains only safe characters (no path traversal). */
export function isValidPresetId(presetId: string): boolean {
	return VALID_PRESET_ID.test(presetId);
}

/** Validate that a destination path is within allowed directories.
 *  Uses realpathSync to resolve symlinks — prevents symlink-based path traversal. */
function isAllowedDestPath(dest: string): boolean {
	const resolved = resolve(dest);
	try {
		const real = realpathSync(resolved);
		return ALLOWED_DEST_PREFIXES.some((prefix) => real.startsWith(prefix));
	} catch {
		// Path doesn't exist yet (new file/dir) — validate resolved path
		return ALLOWED_DEST_PREFIXES.some((prefix) => resolved.startsWith(prefix));
	}
}

/** Validate manifest structure at runtime. Returns null if invalid. */
function validateManifest(data: unknown): PresetManifest | null {
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const m = data as Record<string, unknown>;
	if (typeof m.id !== "string" || !m.id) return null;
	if (typeof m.name !== "string" || !m.name) return null;
	if (typeof m.description !== "string") return null;
	if (typeof m.version !== "string") return null;
	if (typeof m.author !== "string") return null;
	if (typeof m.icon !== "string") return null;
	if (
		!Array.isArray(m.tags) ||
		!m.tags.every((t: unknown) => typeof t === "string")
	)
		return null;
	if (m.extends !== null && typeof m.extends !== "string") return null;
	if (!Array.isArray(m.files)) return null;
	for (const f of m.files) {
		if (!f || typeof f !== "object") return null;
		const file = f as Record<string, unknown>;
		if (typeof file.src !== "string" || typeof file.dest !== "string")
			return null;
		if (
			file.skipIfExists !== undefined &&
			typeof file.skipIfExists !== "boolean"
		)
			return null;
	}
	if (!Array.isArray(m.directories)) return null;
	for (const d of m.directories) {
		if (typeof d !== "string") return null;
	}
	// Optional recursive_dirs
	if (m.recursive_dirs !== undefined) {
		if (!Array.isArray(m.recursive_dirs)) return null;
		for (const rd of m.recursive_dirs) {
			if (!rd || typeof rd !== "object") return null;
			const entry = rd as Record<string, unknown>;
			if (typeof entry.src !== "string" || typeof entry.dest !== "string")
				return null;
			if (typeof entry.recursive !== "boolean") return null;
			if (typeof entry.skipIfExists !== "boolean") return null;
		}
	}
	return data as PresetManifest;
}

/** Compare semver strings: returns true if available is strictly newer than installed. */
function isNewerVersion(installed: string, available: string): boolean {
	const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
	const [iMaj, iMin, iPat] = parse(installed);
	const [aMaj, aMin, aPat] = parse(available);
	if (aMaj !== iMaj) return aMaj > iMaj;
	if (aMin !== iMin) return aMin > iMin;
	return aPat > iPat;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Scan all preset directories for manifest.json and return available presets.
 * Sorted with "default" first.
 */
export function listPresets(): PresetManifest[] {
	const presets: PresetManifest[] = [];

	if (!existsSync(TEMPLATES_DIR)) return presets;

	for (const dir of readdirSync(TEMPLATES_DIR)) {
		const manifestPath = join(TEMPLATES_DIR, dir, "manifest.json");
		if (!existsSync(manifestPath)) continue;

		try {
			const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
			const manifest = validateManifest(raw);
			if (manifest) {
				presets.push(manifest);
			} else {
				console.warn(`[Preset] Invalid manifest schema at ${manifestPath}`);
			}
		} catch (err) {
			console.error(
				`[Preset] Error reading manifest at ${manifestPath}:`,
				(err as Error).message,
			);
		}
	}

	// Sort: "default" first, then alphabetical
	presets.sort((a, b) => {
		if (a.id === "default") return -1;
		if (b.id === "default") return 1;
		return a.name.localeCompare(b.name);
	});

	return presets;
}

/**
 * Read /workspace/.codeck/config.json to check if a preset has been applied.
 */
export function getPresetStatus(): PresetStatus {
	const empty: PresetStatus = {
		configured: false,
		presetId: null,
		presetName: null,
		configuredAt: null,
		version: null,
		availableVersion: null,
		updateAvailable: false,
		autoUpdate: true,
	};
	if (!existsSync(CONFIG_FILE)) return empty;
	try {
		const config: PresetConfig = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
		// Check if the template has a newer version than what's installed
		const manifest = config.presetId ? loadManifest(config.presetId) : null;
		const availableVersion = manifest?.version ?? null;
		const updateAvailable = !!(
			availableVersion &&
			config.version &&
			isNewerVersion(config.version, availableVersion)
		);
		return {
			configured: true,
			presetId: config.presetId,
			presetName: config.presetName,
			configuredAt: config.configuredAt,
			version: config.version,
			availableVersion,
			updateAvailable,
			autoUpdate: config.autoUpdate !== false,
		};
	} catch (e) {
		console.warn("[Preset] Failed to read config:", (e as Error).message);
		return empty;
	}
}

/**
 * Check if the bundled preset template is newer than the installed version.
 * If so, copy only script files (scripts/*.mjs, scripts/*.sh, scripts/ecc/*, scripts/lib/*)
 * to /workspace/.codeck/scripts/ and update the installed version in config.json.
 *
 * Safe files that are NEVER overwritten:
 *   preferences.md, MEMORY.md, constitution.md, settings.json,
 *   memory/**, state/**
 */
export function setAutoUpdate(enabled: boolean): void {
	try {
		let config: Record<string, unknown> = {};
		if (existsSync(CONFIG_FILE)) {
			const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed)
			) {
				config = parsed;
			}
		}
		config.autoUpdate = enabled;
		writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
			mode: 0o600,
		});
	} catch (e) {
		console.warn("[Preset] Failed to set autoUpdate:", (e as Error).message);
	}
}

export function checkPresetUpdate(): void {
	const status = getPresetStatus();
	if (!status.configured || !status.presetId || !status.version) return;
	if (!status.autoUpdate) return;

	const manifest = loadManifest(status.presetId);
	if (!manifest) return;

	if (!isNewerVersion(status.version, manifest.version)) return;

	console.log(
		`[Preset] Auto-updating files from ${status.version} to ${manifest.version}...`,
	);

	const presetDir = join(TEMPLATES_DIR, status.presetId);
	let copied = 0;

	// Copy all manifest files except user-customizable or protected user data
	for (const file of manifest.files) {
		if (file.skipIfExists) continue; // user-customizable file — never overwrite
		const dest = rewritePath(file.dest);
		// Protect user data paths even if not marked skipIfExists
		if (
			dest.endsWith("preferences.md") ||
			dest.endsWith("MEMORY.md") ||
			dest.endsWith("constitution.md") ||
			dest.endsWith("settings.json") ||
			dest.includes("/memory/") ||
			dest.includes("/state/")
		)
			continue;

		const srcPath = join(presetDir, file.src);
		const resolvedSrc = resolve(srcPath);
		if (
			!resolvedSrc.startsWith(TEMPLATES_DIR + "/") &&
			resolvedSrc !== TEMPLATES_DIR
		)
			continue;
		if (!existsSync(srcPath)) continue;
		if (!isAllowedDestPath(dest)) continue;

		try {
			const destDir = dirname(dest);
			if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
			copyFileSync(srcPath, dest);
			copied++;
		} catch (e) {
			console.warn(
				`[Preset]   Failed to copy ${file.src}: ${(e as Error).message}`,
			);
		}
	}

	// Copy all recursive dirs. Non-skip dirs (e.g. rules-library) are preset-managed
	// and fully overwritten. skipIfExists dirs (agents/skills/commands/rules) are
	// user-customizable: we deploy NEW files (so updates ship new agents/skills/
	// commands) but never overwrite files the user may have tweaked.
	if (manifest.recursive_dirs) {
		for (const rd of manifest.recursive_dirs) {
			const destDir = rewritePath(rd.dest);
			if (!isAllowedDestPath(destDir)) continue;

			const srcDir = join(presetDir, rd.src);
			const resolvedSrc = resolve(srcDir);
			if (
				!resolvedSrc.startsWith(TEMPLATES_DIR + "/") &&
				resolvedSrc !== TEMPLATES_DIR
			)
				continue;
			if (!existsSync(srcDir)) continue;

			copied += copyScriptDirRecursive(srcDir, destDir, rd.skipIfExists === true);
		}
	}

	// Merge new hooks from preset template into user settings
	mergePresetHooks(presetDir);

	// Note: mergePresetHooks already removes ghost hooks and stale preset-managed
	// hooks during its bidirectional sync — no separate cleanup step needed.

	// Update installed version in config.json
	try {
		let config: Record<string, unknown> = {};
		if (existsSync(CONFIG_FILE)) {
			const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed)
			) {
				config = parsed;
			}
		}
		config.version = manifest.version;
		writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
			mode: 0o600,
		});
	} catch (e) {
		console.warn(
			"[Preset] Failed to update config version:",
			(e as Error).message,
		);
	}

	console.log(
		`[Preset] Auto-updated files from ${status.version} to ${manifest.version} (${copied} files)`,
	);

	// Re-apply user overrides after auto-update so disabled items stay removed
	applyOverrides(readOverrides());
}

/** Copy script files from srcDir to destDir recursively. Returns count of files copied. */
function copyScriptDirRecursive(
	srcDir: string,
	destDir: string,
	skipExisting = false,
): number {
	if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
	let count = 0;
	for (const entry of readdirSync(srcDir)) {
		const srcEntry = join(srcDir, entry);
		const destEntry = join(destDir, entry);
		const stat = statSync(srcEntry);
		if (stat.isDirectory()) {
			count += copyScriptDirRecursive(srcEntry, destEntry, skipExisting);
		} else {
			// skipExisting: deploy NEW files only, never overwrite a user-customized
			// existing file. Lets updates add new agents/skills/commands into
			// skipIfExists dirs without clobbering the user's tweaks.
			if (skipExisting && existsSync(destEntry)) continue;
			const destEntryDir = dirname(destEntry);
			if (!existsSync(destEntryDir))
				mkdirSync(destEntryDir, { recursive: true });
			copyFileSync(srcEntry, destEntry);
			count++;
		}
	}
	return count;
}

/**
 * Apply a preset by reading its manifest and copying declared files.
 * Supports `extends` with circular-reference guard (max depth 5).
 */
export async function applyPreset(
	presetId: string,
	force = false,
): Promise<void> {
	await applyPresetRecursive(presetId, new Set(), 0, force);
}

// ── Internal ─────────────────────────────────────────────────────────

/**
 * Migrate old flat rules/ layout to rules/base/ + rules/user/ structure.
 * Only runs once (when old-style loose files exist). Idempotent.
 */
function migrateRulesLayout(codeckDir: string): void {
	const rulesDir = join(codeckDir, "rules");
	if (!existsSync(rulesDir)) return;

	// Move ALL loose .md files in rules/ to rules/user/.
	// base/ files are preset-managed (overwritten on update), so user customizations
	// must go to user/ where they're protected from overwrites.
	const userDir = join(rulesDir, "user");
	try {
		for (const entry of readdirSync(rulesDir)) {
			const entryPath = join(rulesDir, entry);
			if (!statSync(entryPath).isFile()) continue;
			if (!entry.endsWith(".md")) continue;
			const userDest = join(userDir, entry);
			if (existsSync(userDest)) {
				console.log(
					`[Preset]   SKIP migration ${entryPath} (${userDest} already exists)`,
				);
				continue;
			}
			if (!existsSync(userDir)) mkdirSync(userDir, { recursive: true });
			renameSync(entryPath, userDest);
			console.log(`[Preset]   MIGRATE ${entryPath} → ${userDest}`);
		}
	} catch (e) {
		console.warn(`[Preset]   Failed to migrate rules:`, (e as Error).message);
	}
}

// Prefix that identifies preset-managed hooks (vs user-added hooks)
// Use rewritePath to handle non-Docker deployments where WORKSPACE differs
const PRESET_HOOK_PREFIX = rewritePath("/workspace/.codeck/scripts/");

/**
 * Extract all command strings from a hooks entry array.
 * Each entry has { matcher, hooks: [{ type, command }] }.
 */
function extractCommands(entries: unknown[]): Set<string> {
	const cmds = new Set<string>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const hooks = (entry as Record<string, unknown>).hooks;
		if (!Array.isArray(hooks)) continue;
		for (const h of hooks) {
			if (
				h &&
				typeof h === "object" &&
				typeof (h as Record<string, unknown>).command === "string"
			) {
				cmds.add((h as Record<string, unknown>).command as string);
			}
		}
	}
	return cmds;
}

/**
 * Sync preset hooks with settings.json.
 * Adds missing preset hooks and removes stale preset-managed hooks
 * (commands under PRESET_HOOK_PREFIX that are no longer in the template).
 * User-added hooks (non-preset) are never touched.
 */

function mergePresetHooks(presetDir: string): void {
	const templatePath = join(presetDir, "ecc", "settings.json");
	const settingsDest = rewritePath("/root/.claude/settings.json");

	if (!existsSync(templatePath) || !existsSync(settingsDest)) return;

	try {
		const template = JSON.parse(readFileSync(templatePath, "utf-8"));
		const current = JSON.parse(readFileSync(settingsDest, "utf-8"));

		const templateHooks = template.hooks;
		if (!templateHooks || typeof templateHooks !== "object") return;

		if (!current.hooks || typeof current.hooks !== "object") {
			current.hooks = {};
		}

		let added = 0;
		for (const [event, templateEntries] of Object.entries(templateHooks)) {
			if (!Array.isArray(templateEntries)) continue;

			// Get existing commands for this event
			const currentEntries: unknown[] = Array.isArray(current.hooks[event])
				? current.hooks[event]
				: [];
			const existingCmds = extractCommands(currentEntries);

			// Add missing preset entries
			for (const entry of templateEntries) {
				if (!entry || typeof entry !== "object") continue;
				const hooks = (entry as Record<string, unknown>).hooks;
				if (!Array.isArray(hooks)) continue;

				// Rewrite command paths for non-Docker deployments
				const rewrittenEntry = JSON.parse(JSON.stringify(entry));
				const rewrittenHooks = (rewrittenEntry as Record<string, unknown>)
					.hooks as Array<Record<string, unknown>>;
				for (const h of rewrittenHooks) {
					if (typeof h.command === "string") {
						h.command = rewritePath(h.command);
					}
				}

				// Check if ALL commands in this entry are preset-managed
				const cmds = rewrittenHooks
					.filter((h) => typeof h.command === "string")
					.map((h) => h.command as string);

				const allPresetManaged = cmds.every((c) =>
					c.includes(PRESET_HOOK_PREFIX),
				);
				if (!allPresetManaged) continue; // skip non-preset hooks

				const allExist = cmds.every((c) => existingCmds.has(c));
				if (allExist) continue; // already installed

				if (!Array.isArray(current.hooks[event])) {
					current.hooks[event] = [];
				}
				current.hooks[event].push(rewrittenEntry);
				added++;
				console.log(`[Preset]   MERGE hook: ${event} ← ${cmds.join(", ")}`);
			}
		}

		// Remove stale preset-managed hooks that are no longer in the template
		// and remove non-executable ghost hooks (plain text commands)
		let removed = 0;
		for (const event of Object.keys(current.hooks)) {
			const entries = current.hooks[event];
			if (!Array.isArray(entries)) continue;

			// Build set of template commands for this event (rewritten paths)
			const templateCmds = new Set<string>();
			const tEntries = templateHooks[event];
			if (Array.isArray(tEntries)) {
				for (const te of tEntries) {
					if (!te || typeof te !== "object") continue;
					const th = (te as Record<string, unknown>).hooks;
					if (!Array.isArray(th)) continue;
					for (const h of th) {
						if (
							h &&
							typeof h === "object" &&
							typeof (h as Record<string, unknown>).command === "string"
						) {
							templateCmds.add(
								rewritePath((h as Record<string, unknown>).command as string),
							);
						}
					}
				}
			}

			const before = entries.length;
			current.hooks[event] = entries.filter(
				(entry: { hooks?: Array<{ command?: string }> }) => {
					const hooks = entry.hooks || [];
					if (hooks.length === 0) return false;

					for (const h of hooks) {
						const cmd = (h.command || "").trim();
						// Remove ghost hooks (plain text, not executable)
						if (
							cmd &&
							!cmd.startsWith("node ") &&
							!cmd.startsWith("bash ") &&
							!cmd.startsWith("sh ") &&
							!cmd.startsWith("python ") &&
							!cmd.startsWith("python3 ") &&
							!cmd.startsWith("/")
						) {
							return false;
						}
						// Remove stale preset-managed hooks no longer in template
						if (cmd.includes(PRESET_HOOK_PREFIX) && !templateCmds.has(cmd)) {
							return false;
						}
					}
					return true;
				},
			);
			removed += before - current.hooks[event].length;
		}

		// Also merge statusLine if present in template and not in current
		if (template.statusLine && !current.statusLine) {
			const sl = JSON.parse(JSON.stringify(template.statusLine));
			if (typeof sl.command === "string") {
				sl.command = rewritePath(sl.command);
			}
			current.statusLine = sl;
			added++;
			console.log(`[Preset]   MERGE statusLine: ${sl.command}`);
		}

		if (added > 0 || removed > 0) {
			writeFileSync(settingsDest, JSON.stringify(current, null, 2));
			if (added > 0) console.log(`[Preset]   Merged ${added} new hook(s)`);
			if (removed > 0)
				console.log(`[Preset]   Removed ${removed} stale/invalid hook(s)`);
		}
	} catch (e) {
		console.warn(`[Preset]   Failed to merge hooks:`, (e as Error).message);
	}
}

/**
 * Register preset MCP servers in Claude Code's .claude.json (user scope).
 * Claude Code reads MCP servers from .claude.json, NOT from mcp.json.
 * This writes to the global mcpServers key so servers are available in all projects.
 */
function registerMcpServers(presetDir: string): void {
	const mcpTemplatePath = join(presetDir, "mcp.json");
	const claudeJsonPath = join(home, ".claude.json");

	if (!existsSync(mcpTemplatePath)) return;

	try {
		const template = JSON.parse(readFileSync(mcpTemplatePath, "utf-8"));
		const servers = template.mcpServers;
		if (!servers || typeof servers !== "object") return;

		let claudeJson: Record<string, unknown> = {};
		if (existsSync(claudeJsonPath)) {
			const parsed = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed)
			) {
				claudeJson = parsed;
			}
		}

		if (!claudeJson.mcpServers || typeof claudeJson.mcpServers !== "object") {
			claudeJson.mcpServers = {};
		}
		const existing = claudeJson.mcpServers as Record<string, unknown>;

		// Auto-populate GitHub token from gh CLI if available
		if (servers.github && typeof servers.github === "object") {
			const ghConfig = servers.github as Record<string, unknown>;
			const ghEnv = (ghConfig.env || {}) as Record<string, string>;
			if (!ghEnv.GITHUB_TOKEN) {
				try {
					const token = execFileSync("gh", ["auth", "token"], {
						encoding: "utf-8",
						timeout: 5000,
					}).trim();
					if (token) {
						ghEnv.GITHUB_TOKEN = token;
						ghConfig.env = ghEnv;
						console.log("[Preset]   Auto-populated GITHUB_TOKEN from gh CLI");
					}
				} catch {
					/* gh not authenticated — leave empty */
				}
			}
		}

		// Read user env vars to hydrate MCP server configs
		let userEnvVars: Record<string, string> = {};
		try {
			const envPath = join(
				process.env.WORKSPACE || "/workspace",
				".codeck",
				".env",
			);
			if (existsSync(envPath)) {
				const envContent = readFileSync(envPath, "utf-8");
				for (const line of envContent.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith("#")) continue;
					const eqIdx = trimmed.indexOf("=");
					if (eqIdx > 0) {
						userEnvVars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
					}
				}
			}
		} catch {
			/* non-fatal */
		}

		let added = 0;
		for (const [name, config] of Object.entries(servers)) {
			if (existing[name]) continue; // don't overwrite user-configured servers
			// Try to populate empty env vars from .codeck/.env or encrypted env
			const env = (config as Record<string, unknown>).env as
				| Record<string, string>
				| undefined;
			if (env) {
				for (const [k, v] of Object.entries(env)) {
					if (v === "" && userEnvVars[k]) {
						env[k] = userEnvVars[k];
						console.log(`[Preset]   Populated ${name}.env.${k} from user env`);
					}
				}
			}
			existing[name] = config;
			added++;
			console.log(`[Preset]   REGISTER MCP server: ${name}`);
		}

		// Also register disabled servers (need API keys) — they show in UI
		// and get enabled when user configures the integration
		const disabledServers = template._disabledMcpServers;
		if (disabledServers && typeof disabledServers === "object") {
			for (const [name, config] of Object.entries(disabledServers)) {
				if (existing[name]) continue;
				const serverConfig = config as Record<string, unknown>;
				// Try to populate env vars — if all filled, register as enabled
				const env = serverConfig.env as Record<string, string> | undefined;
				let allFilled = true;
				if (env) {
					for (const [k, v] of Object.entries(env)) {
						if (v === "" && userEnvVars[k]) {
							env[k] = userEnvVars[k];
							console.log(
								`[Preset]   Populated ${name}.env.${k} from user env`,
							);
						}
						if (env[k] === "") allFilled = false;
					}
				}
				if (!allFilled) {
					serverConfig.disabled = true;
				}
				existing[name] = serverConfig;
				added++;
				console.log(
					`[Preset]   REGISTER MCP server: ${name}${allFilled ? "" : " (disabled — needs API key)"}`,
				);
			}
		}

		if (added > 0) {
			writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
			console.log(
				`[Preset]   Registered ${added} MCP server(s) in .claude.json (user scope)`,
			);
		}
	} catch (e) {
		console.warn(
			`[Preset]   Failed to register MCP servers:`,
			(e as Error).message,
		);
	}
}

async function applyPresetRecursive(
	presetId: string,
	visited: Set<string>,
	depth: number,
	force: boolean,
): Promise<void> {
	if (depth > 5) {
		throw new Error(
			`Preset extends chain too deep (>5). Possible circular reference.`,
		);
	}
	if (visited.has(presetId)) {
		throw new Error(
			`Circular preset extends detected: "${presetId}" already applied in this chain.`,
		);
	}
	visited.add(presetId);

	// Run rules layout migration at the top-level call only
	if (depth === 0) {
		migrateRulesLayout(WORKSPACE_CODECK);
	}

	const manifest = loadManifest(presetId);
	if (!manifest) {
		throw new Error(`Preset "${presetId}" not found.`);
	}

	// Cross-validate manifest.id matches the directory name
	if (manifest.id !== presetId) {
		throw new Error(
			`Manifest id "${manifest.id}" doesn't match preset directory "${presetId}".`,
		);
	}

	console.log(`[Preset] Applying "${manifest.id}" (${manifest.name})...`);

	// If this preset extends another, apply the parent first
	if (manifest.extends) {
		await applyPresetRecursive(manifest.extends, visited, depth + 1, force);
	}

	// Create declared directories (validate paths, rewrite for deployment mode)
	for (const rawDir of manifest.directories) {
		const dir = rewritePath(rawDir);
		if (!isAllowedDestPath(dir)) {
			console.warn(
				`[Preset]   BLOCKED: directory "${dir}" outside allowed prefixes`,
			);
			continue;
		}
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
			console.log(`[Preset]   mkdir ${dir}`);
		}
	}

	// Copy declared files: read from template source, write to dest
	const presetDir = join(TEMPLATES_DIR, presetId);
	for (const file of manifest.files) {
		const dest = rewritePath(file.dest);
		// Validate destination path
		if (!isAllowedDestPath(dest)) {
			console.warn(
				`[Preset]   BLOCKED: dest path "${dest}" outside allowed prefixes`,
			);
			continue;
		}

		const srcPath = join(presetDir, file.src);

		// Validate source path stays within TEMPLATES_DIR
		const resolvedSrc = resolve(srcPath);
		if (
			!resolvedSrc.startsWith(TEMPLATES_DIR + "/") &&
			resolvedSrc !== TEMPLATES_DIR
		) {
			console.warn(
				`[Preset]   BLOCKED: src path "${file.src}" resolves outside templates directory`,
			);
			continue;
		}

		if (!existsSync(srcPath)) {
			console.warn(`[Preset]   SKIP ${file.src} (source not found)`);
			continue;
		}

		// Ensure destination directory exists
		const destDir = dirname(dest);
		if (!existsSync(destDir)) {
			mkdirSync(destDir, { recursive: true });
		}

		// Write file (don't overwrite user edits for data files, unless force)
		const isDataFile =
			dest.includes("/memory/") ||
			dest.endsWith("preferences.md") ||
			dest.endsWith("constitution.md") ||
			dest.includes("/rules/user/");
		if (!force && file.skipIfExists && existsSync(dest)) {
			console.log(`[Preset]   KEEP ${dest} (skipIfExists)`);
		} else if (!force && isDataFile && existsSync(dest)) {
			console.log(`[Preset]   KEEP ${dest} (user data exists)`);
		} else {
			// Backup data files before force-overwrite
			if (force && isDataFile && existsSync(dest)) {
				backupFile(dest);
			}
			let fileContent = readFileSync(srcPath, "utf-8");
			// For markdown files: rewrite template placeholders to actual runtime paths.
			// This allows a single template to work correctly across Docker (/workspace/)
			// and non-Docker deployments (e.g. /home/codeck/workspace/).
			if (
				dest.endsWith(".md") &&
				(WORKSPACE !== "/workspace" || home !== "/root")
			) {
				fileContent = fileContent
					.replace(/\/workspace\//g, `${WORKSPACE}/`)
					.replace(/\/workspace(?=\s|$|['"`,)])/g, WORKSPACE)
					.replace(/\/root\//g, `${home}/`);
			}
			writeFileSync(dest, fileContent);
			console.log(`[Preset]   WRITE ${dest}`);
		}
	}

	// Merge preset hooks into existing settings.json (additive-only).
	// settings.json uses skipIfExists to protect user permissions, but that means
	// new hooks added in preset updates never reach existing users. This merge
	// adds missing preset-managed hooks (identified by /workspace/.codeck/scripts/ path)
	// without touching user permissions, model settings, or custom hooks.
	mergePresetHooks(presetDir);

	// Register MCP servers in Claude Code's .claude.json (user scope).
	// mcp.json alone is not read by Claude Code — servers must be in .claude.json.
	registerMcpServers(presetDir);

	// Copy recursive directories declared in the manifest
	if (manifest.recursive_dirs && manifest.recursive_dirs.length > 0) {
		console.log(
			`[Preset] Copying recursive directories for "${manifest.id}"...`,
		);
		for (const rd of manifest.recursive_dirs) {
			const srcDir = join(presetDir, rd.src);
			const destDir = rewritePath(rd.dest);

			// Validate destination
			if (!isAllowedDestPath(destDir)) {
				console.warn(
					`[Preset]   BLOCKED: recursive_dirs dest "${destDir}" outside allowed prefixes`,
				);
				continue;
			}

			// Validate source path
			const resolvedSrc = resolve(srcDir);
			if (
				!resolvedSrc.startsWith(TEMPLATES_DIR + "/") &&
				resolvedSrc !== TEMPLATES_DIR
			) {
				console.warn(
					`[Preset]   BLOCKED: recursive_dirs src "${rd.src}" resolves outside templates directory`,
				);
				continue;
			}

			copyDirectoryRecursive(srcDir, destDir, manifest.id, {
				skipIfExists: rd.skipIfExists,
			});
		}
	}

	// Write config.json (only for the top-level preset, not parents)
	// Read-merge-write to preserve other keys (e.g. permissions)
	if (!existsSync(WORKSPACE_CODECK)) {
		mkdirSync(WORKSPACE_CODECK, { recursive: true, mode: 0o700 });
	}
	let existing: Record<string, unknown> = {};
	try {
		if (existsSync(CONFIG_FILE)) {
			const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed)
			) {
				existing = parsed;
			}
		}
	} catch {
		/* start fresh */
	}
	existing.presetId = manifest.id;
	existing.presetName = manifest.name;
	existing.configuredAt = new Date().toISOString();
	existing.version = manifest.version;
	writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2), {
		mode: 0o600,
	});
	console.log(
		`[Preset] ✓ "${manifest.id}" applied. Config written to ${CONFIG_FILE}`,
	);

	// Apply user overrides after preset files are in place (top-level call only)
	if (depth === 0) {
		applyOverrides(readOverrides());
	}
}

function loadManifest(presetId: string): PresetManifest | null {
	// Validate presetId to prevent path traversal
	if (!isValidPresetId(presetId)) {
		console.warn(`[Preset] Invalid preset ID: "${presetId}"`);
		return null;
	}

	const manifestPath = join(TEMPLATES_DIR, presetId, "manifest.json");

	// Double-check resolved path stays within TEMPLATES_DIR
	const resolvedPath = resolve(manifestPath);
	if (!resolvedPath.startsWith(TEMPLATES_DIR + "/")) {
		console.warn(
			`[Preset] Path traversal blocked for preset ID: "${presetId}"`,
		);
		return null;
	}

	if (!existsSync(manifestPath)) return null;

	try {
		const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
		const manifest = validateManifest(raw);
		if (!manifest) {
			console.warn(`[Preset] Invalid manifest schema for preset "${presetId}"`);
			return null;
		}
		return manifest;
	} catch (e) {
		console.warn(
			`[Preset] Failed to load manifest "${presetId}":`,
			(e as Error).message,
		);
		return null;
	}
}

/**
 * Recursively copy a directory from srcDir (within TEMPLATES_DIR) to destDir.
 * - Respects skipIfExists: skips files that already exist at the destination.
 * - Applies path rewriting to .md files (same as individual file copy).
 * - Validates all destination paths stay within ALLOWED_DEST_PREFIXES.
 */
function copyDirectoryRecursive(
	srcDir: string,
	destDir: string,
	presetId: string,
	opts: { skipIfExists: boolean },
): void {
	// Validate source path stays within TEMPLATES_DIR
	const resolvedSrc = resolve(srcDir);
	if (
		!resolvedSrc.startsWith(TEMPLATES_DIR + "/") &&
		resolvedSrc !== TEMPLATES_DIR
	) {
		console.warn(
			`[Preset]   BLOCKED: recursive src "${srcDir}" resolves outside templates directory`,
		);
		return;
	}

	if (!existsSync(srcDir)) {
		console.warn(
			`[Preset]   SKIP recursive copy: source dir not found: ${srcDir}`,
		);
		return;
	}

	// Validate destination
	if (!isAllowedDestPath(destDir)) {
		console.warn(
			`[Preset]   BLOCKED: recursive dest "${destDir}" outside allowed prefixes`,
		);
		return;
	}

	if (!existsSync(destDir)) {
		mkdirSync(destDir, { recursive: true });
	}

	for (const entry of readdirSync(srcDir)) {
		const srcEntry = join(srcDir, entry);
		const destEntry = join(destDir, entry);

		const stat = statSync(srcEntry);
		if (stat.isDirectory()) {
			copyDirectoryRecursive(srcEntry, destEntry, presetId, opts);
		} else {
			if (opts.skipIfExists && existsSync(destEntry)) {
				console.log(`[Preset]   KEEP ${destEntry} (skipIfExists)`);
				continue;
			}

			// Ensure destination parent directory exists
			const destEntryDir = dirname(destEntry);
			if (!existsSync(destEntryDir)) {
				mkdirSync(destEntryDir, { recursive: true });
			}

			let fileContent = readFileSync(srcEntry, "utf-8");
			// Rewrite template paths in .md files
			if (
				destEntry.endsWith(".md") &&
				(WORKSPACE !== "/workspace" || home !== "/root")
			) {
				fileContent = fileContent
					.replace(/\/workspace\//g, `${WORKSPACE}/`)
					.replace(/\/workspace(?=\s|$|['"`,)])/g, WORKSPACE)
					.replace(/\/root\//g, `${home}/`);
			}
			writeFileSync(destEntry, fileContent);
			console.log(`[Preset]   WRITE ${destEntry}`);
		}
	}
}

/** Create a timestamped backup of a file before overwriting. */
function backupFile(filePath: string): void {
	try {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const backupDir = join(BACKUPS_DIR, timestamp);
		if (!existsSync(backupDir)) {
			mkdirSync(backupDir, { recursive: true });
		}
		const fileName = filePath.replace(/\//g, "__");
		copyFileSync(filePath, join(backupDir, fileName));
		console.log(`[Preset]   BACKUP ${filePath} → ${backupDir}/${fileName}`);
	} catch (e) {
		console.warn(
			`[Preset]   Failed to backup ${filePath}:`,
			(e as Error).message,
		);
	}
}
