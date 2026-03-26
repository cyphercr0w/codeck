import { Router } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const router = Router();

const CLAUDE_JSON_PATH = join(process.env.HOME || "/root", ".claude.json");

interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	description?: string;
	disabled?: boolean;
}

interface ClaudeJson {
	mcpServers?: Record<string, McpServerConfig>;
	_disabledMcpServers?: Record<string, McpServerConfig>;
	[key: string]: unknown;
}

async function readClaudeJson(): Promise<ClaudeJson> {
	try {
		const raw = await readFile(CLAUDE_JSON_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			return parsed as ClaudeJson;
		}
	} catch {
		/* file missing or invalid */
	}
	return {};
}

async function writeClaudeJson(data: ClaudeJson): Promise<void> {
	await writeFile(CLAUDE_JSON_PATH, JSON.stringify(data, null, 2));
}

// GET / — List all MCP servers (active + disabled)
router.get("/", asyncHandler(async (_req, res) => {
	try {
		const config = await readClaudeJson();
		const active = config.mcpServers || {};
		const disabled = config._disabledMcpServers || {};

		const servers = [
			...Object.entries(active).map(([name, cfg]) => ({
				name,
				command: cfg.command,
				args: cfg.args || [],
				envKeys: Object.keys(cfg.env || {}),
				description: cfg.description || "",
				enabled: !cfg.disabled,
			})),
			...Object.entries(disabled).map(([name, cfg]) => ({
				name,
				command: cfg.command,
				args: cfg.args || [],
				envKeys: Object.keys(cfg.env || {}),
				description: cfg.description || "",
				enabled: false,
			})),
		];

		res.json({ servers });
	} catch (err) {
		res.status(500).json({ success: false, error: (err as Error).message });
	}
}));

// POST / — Add or update an MCP server
router.post("/", asyncHandler(async (req, res) => {
	try {
		const { name, command, args, env, description } = req.body;

		if (!name || typeof name !== "string") {
			res.status(400).json({ success: false, error: "name is required" });
			return;
		}
		if (!command || typeof command !== "string") {
			res.status(400).json({ success: false, error: "command is required" });
			return;
		}

		const config = await readClaudeJson();
		if (!config.mcpServers) config.mcpServers = {};

		const serverConfig: McpServerConfig = { command };
		if (args && Array.isArray(args)) serverConfig.args = args;
		if (env && typeof env === "object" && !Array.isArray(env))
			serverConfig.env = env;
		if (description && typeof description === "string")
			serverConfig.description = description;

		config.mcpServers[name] = serverConfig;

		// If it was previously disabled, remove from disabled list
		if (config._disabledMcpServers?.[name]) {
			delete config._disabledMcpServers[name];
			if (Object.keys(config._disabledMcpServers).length === 0) {
				delete config._disabledMcpServers;
			}
		}

		await writeClaudeJson(config);
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ success: false, error: (err as Error).message });
	}
}));

// DELETE /:name — Remove an MCP server
router.delete("/:name", asyncHandler(async (req, res) => {
	try {
		const { name } = req.params;
		const config = await readClaudeJson();

		let found = false;

		if (config.mcpServers?.[name]) {
			delete config.mcpServers[name];
			found = true;
		}
		if (config._disabledMcpServers?.[name]) {
			delete config._disabledMcpServers[name];
			if (Object.keys(config._disabledMcpServers).length === 0) {
				delete config._disabledMcpServers;
			}
			found = true;
		}

		if (!found) {
			res
				.status(404)
				.json({ success: false, error: `Server '${name}' not found` });
			return;
		}

		await writeClaudeJson(config);
		res.json({ success: true });
	} catch (err) {
		res.status(500).json({ success: false, error: (err as Error).message });
	}
}));

// POST /:name/toggle — Enable/disable an MCP server
router.post("/:name/toggle", asyncHandler(async (req, res) => {
	try {
		const { name } = req.params;
		const config = await readClaudeJson();

		if (!config.mcpServers) config.mcpServers = {};
		if (!config._disabledMcpServers) config._disabledMcpServers = {};

		// Check mcpServers first (may have disabled flag)
		if (config.mcpServers[name]) {
			const serverConfig = config.mcpServers[name];
			if (serverConfig.disabled) {
				// Currently disabled via flag → enable
				delete serverConfig.disabled;
				await writeClaudeJson(config);
				res.json({ success: true, enabled: true });
			} else {
				// Currently active → disable via flag
				serverConfig.disabled = true;
				await writeClaudeJson(config);
				res.json({ success: true, enabled: false });
			}
			return;
		}

		// Legacy: check _disabledMcpServers
		if (config._disabledMcpServers?.[name]) {
			const serverConfig = config._disabledMcpServers[name];
			delete config._disabledMcpServers[name];
			if (Object.keys(config._disabledMcpServers).length === 0) {
				delete config._disabledMcpServers;
			}
			config.mcpServers[name] = serverConfig;
			await writeClaudeJson(config);
			res.json({ success: true, enabled: true });
			return;
		}

		res
			.status(404)
			.json({ success: false, error: `Server '${name}' not found` });
	} catch (err) {
		res.status(500).json({ success: false, error: (err as Error).message });
	}
}));

// GET /search — Search the official MCP registry
// Proxied server-side to avoid CORS issues from the browser.
const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";

// Simple in-memory cache: { key → { data, ts } }
const searchCache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

router.get("/search", asyncHandler(async (req, res) => {
	try {
		const q = String(req.query.q || "").trim();
		if (!q) {
			res.json({ servers: [] });
			return;
		}

		const cacheKey = `search:${q}`;
		const cached = searchCache.get(cacheKey);
		if (cached && Date.now() - cached.ts < CACHE_TTL) {
			res.json(cached.data);
			return;
		}

		const url = `${REGISTRY_URL}?search=${encodeURIComponent(q)}&limit=30&version=latest`;
		const response = await fetch(url, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			res.status(502).json({
				success: false,
				error: `Registry returned ${response.status}`,
			});
			return;
		}

		const raw = (await response.json()) as {
			servers?: Array<{
				server: {
					name: string;
					title?: string;
					description?: string;
					remotes?: Array<unknown>;
					packages?: Array<{
						registryType?: string;
						identifier?: string;
						runtimeHint?: string;
						environmentVariables?: Array<{
							name: string;
							description?: string;
							isRequired?: boolean;
						}>;
					}>;
				};
			}>;
		};

		// Transform to a simpler format for the frontend.
		// Many registry servers are remote-only (Smithery hosted) with no local packages.
		// We include all but prioritize those with installable packages.
		const servers = (raw.servers || [])
			.map((entry) => {
				const s = entry.server;
				const pkg = s.packages?.[0];
				const envVars = pkg?.environmentVariables || [];

				// Derive install command from package info
				let command = "";
				let args: string[] = [];
				if (pkg?.runtimeHint === "npx" || pkg?.registryType === "npm") {
					command = "npx";
					args = ["-y", pkg.identifier || s.name];
				} else if (pkg?.runtimeHint === "uvx" || pkg?.registryType === "pypi") {
					command = "uvx";
					args = [pkg.identifier || s.name];
				} else if (
					pkg?.runtimeHint === "docker" ||
					pkg?.registryType === "oci"
				) {
					command = "docker";
					args = ["run", "-i", "--rm", pkg.identifier || s.name];
				} else if (pkg?.identifier) {
					command = "npx";
					args = ["-y", pkg.identifier];
				}

				// Derive a readable title from the registry name (e.g. "ai.smithery/faithk7-gmail-mcp" → "gmail-mcp")
				const nameParts = s.name.split("/");
				const shortName = nameParts[nameParts.length - 1] || s.name;
				// Clean up smithery-style names: remove author prefix if present (e.g. "faithk7-gmail-mcp" → "gmail-mcp")
				const cleanName = shortName.replace(/^[a-z0-9]+-/, "");

				return {
					registryName: s.name,
					title: s.title || cleanName || shortName,
					description: s.description || "",
					command,
					args,
					envVars: envVars.map((v) => ({
						name: v.name,
						description: v.description || "",
						required: v.isRequired ?? false,
					})),
					runtime:
						pkg?.runtimeHint ||
						pkg?.registryType ||
						(s.remotes?.length ? "remote" : "unknown"),
					installable: !!command,
				};
			})
			// Sort: installable (local) servers first, then remote
			.sort((a, b) => (b.installable ? 1 : 0) - (a.installable ? 1 : 0));

		const result = { servers };
		searchCache.set(cacheKey, { data: result, ts: Date.now() });
		res.json(result);
	} catch (err) {
		res.status(500).json({ success: false, error: (err as Error).message });
	}
}));

export default router;
