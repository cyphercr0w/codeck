/**
 * Sub-Agents — Agent Definitions CRUD API
 *
 * Manages agent .md files in ~/.claude/agents/.
 * Each file has optional YAML frontmatter between --- markers.
 */
import { Router } from "express";
import { readdir, readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { asyncHandler } from "../utils/async-handler.js";

const router = Router();

const AGENTS_DIR = join(process.env.HOME || "/root", ".claude", "agents");

/** Validate agent name — alphanumeric, hyphens, underscores only */
function isValidName(name: string): boolean {
	return /^[a-zA-Z0-9_-]+$/.test(name);
}

interface AgentFrontmatter {
	name?: string;
	description?: string;
	tools?: string[];
	model?: string;
	[key: string]: unknown;
}

interface ParsedAgent {
	frontmatter: AgentFrontmatter;
	body: string;
}

/** Parse YAML frontmatter from agent .md content (no external library) */
function parseFrontmatter(content: string): ParsedAgent {
	const parts = content.split(/^---\s*$/m);

	// Valid frontmatter: content starts with ---, so parts[0] is empty
	if (parts.length >= 3 && parts[0].trim() === "") {
		const frontmatterRaw = parts[1];
		const body = parts.slice(2).join("---\n").trimStart();
		const frontmatter: AgentFrontmatter = {};

		for (const line of frontmatterRaw.split("\n")) {
			const colonIdx = line.indexOf(":");
			if (colonIdx === -1) continue;
			const key = line.slice(0, colonIdx).trim();
			const value = line.slice(colonIdx + 1).trim();
			if (!key) continue;

			if (key === "tools") {
				try {
					const parsed = JSON.parse(value);
					if (Array.isArray(parsed)) {
						frontmatter.tools = parsed as string[];
					}
				} catch {
					// malformed tools — skip
				}
			} else {
				frontmatter[key] = value;
			}
		}

		return { frontmatter, body };
	}

	return { frontmatter: {}, body: content };
}

async function ensureAgentsDir(): Promise<void> {
	await mkdir(AGENTS_DIR, { recursive: true });
}

// GET /api/sub-agents — list all agents (parsed frontmatter only)
router.get(
	"/",
	asyncHandler(async (_req, res) => {
		await ensureAgentsDir();
		const entries = await readdir(AGENTS_DIR).catch(() => [] as string[]);
		const mdFiles = entries.filter((f) => f.endsWith(".md"));

		const agents = await Promise.all(
			mdFiles.map(async (file) => {
				const name = file.slice(0, -3); // strip .md
				try {
					const content = await readFile(join(AGENTS_DIR, file), "utf-8");
					const { frontmatter } = parseFrontmatter(content);
					return {
						name,
						description: (frontmatter.description as string) || "",
						model: (frontmatter.model as string) || "sonnet",
						tools: Array.isArray(frontmatter.tools) ? frontmatter.tools : [],
					};
				} catch {
					return {
						name,
						description: "",
						model: "sonnet",
						tools: [] as string[],
					};
				}
			}),
		);

		res.json({ agents });
	}),
);

// GET /api/sub-agents/:name — read single agent (content + parsed frontmatter)
router.get(
	"/:name",
	asyncHandler(async (req, res) => {
		const name = (req.params.name ?? "").trim();
		if (!isValidName(name)) {
			res.status(400).json({ error: "Invalid agent name" });
			return;
		}

		const filePath = resolve(join(AGENTS_DIR, `${name}.md`));
		if (!filePath.startsWith(AGENTS_DIR)) {
			res.status(400).json({ error: "Invalid agent name" });
			return;
		}

		let content: string;
		try {
			content = await readFile(filePath, "utf-8");
		} catch {
			res.status(404).json({ error: "Agent not found" });
			return;
		}

		const { frontmatter, body } = parseFrontmatter(content);
		res.json({ name, frontmatter, body, content });
	}),
);

// PUT /api/sub-agents/:name — create or update agent file
router.put(
	"/:name",
	asyncHandler(async (req, res) => {
		const name = (req.params.name ?? "").trim();
		if (!isValidName(name)) {
			res.status(400).json({ error: "Invalid agent name" });
			return;
		}

		const { content } = req.body ?? {};
		if (typeof content !== "string") {
			res.status(400).json({ error: "content (string) is required" });
			return;
		}
		if (content.length > 200_000) {
			res.status(400).json({ error: "content too large (max 200,000 chars)" });
			return;
		}

		const filePath = resolve(join(AGENTS_DIR, `${name}.md`));
		if (!filePath.startsWith(AGENTS_DIR)) {
			res.status(400).json({ error: "Invalid agent name" });
			return;
		}

		await ensureAgentsDir();
		await writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });

		const { frontmatter, body } = parseFrontmatter(content);
		res.json({ name, frontmatter, body, content });
	}),
);

// DELETE /api/sub-agents/:name — delete agent file
router.delete(
	"/:name",
	asyncHandler(async (req, res) => {
		const name = (req.params.name ?? "").trim();
		if (!isValidName(name)) {
			res.status(400).json({ error: "Invalid agent name" });
			return;
		}

		const filePath = resolve(join(AGENTS_DIR, `${name}.md`));
		if (!filePath.startsWith(AGENTS_DIR)) {
			res.status(400).json({ error: "Invalid agent name" });
			return;
		}

		try {
			await unlink(filePath);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				res.status(404).json({ error: "Agent not found" });
				return;
			}
			throw err;
		}

		res.json({ ok: true });
	}),
);

export default router;
