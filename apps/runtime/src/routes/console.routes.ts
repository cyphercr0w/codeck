import { Router } from "express";
import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { join, basename, resolve, sep } from "path";
import { isClaudeAuthenticated } from "../services/auth-anthropic.js";
import {
	createConsoleSession,
	createShellSession,
	getSessionCount,
	MAX_SESSIONS,
	resizeSession,
	destroySession,
	renameSession,
	listSessions,
	hasResumableConversations,
} from "../services/console.js";
import { broadcastStatus } from "../web/websocket.js";
import { broadcast } from "../web/logger.js";

const router = Router();

// Create console session (multi-session, max 5)
router.post("/create", (req, res) => {
	if (!isClaudeAuthenticated()) {
		res.status(400).json({ error: "Claude is not authenticated" });
		return;
	}

	if (getSessionCount() >= MAX_SESSIONS) {
		res
			.status(400)
			.json({ error: `Maximum ${MAX_SESSIONS} simultaneous sessions` });
		return;
	}

	const { cwd, resume } = req.body || {};

	// Validate cwd stays within /workspace to prevent path traversal
	if (cwd && typeof cwd === "string") {
		const WORKSPACE = process.env.WORKSPACE || "/workspace";
		const resolved = resolve(cwd);
		if (!resolved.startsWith(WORKSPACE + sep) && resolved !== WORKSPACE) {
			res.status(403).json({ error: "Access denied: cwd outside workspace" });
			return;
		}
	}

	try {
		const session = createConsoleSession({ cwd: cwd || undefined, resume });
		console.log(
			`[Console] Session created: ${session.id} (cwd: ${session.cwd}, resume: ${!!resume})`,
		);
		broadcastStatus();
		res.json({ sessionId: session.id, cwd: session.cwd, name: session.name });
	} catch (e) {
		const detail = e instanceof Error ? e.message : "Failed to create session";
		console.log(`[Console] Session creation failed: ${detail}`);
		res.status(400).json({ error: "Failed to create session" });
	}
});

// Create shell session — does not require Claude OAuth (shells don't use Claude),
// but is still protected by password auth middleware in server.ts
router.post("/create-shell", (req, res) => {
	if (getSessionCount() >= MAX_SESSIONS) {
		res
			.status(400)
			.json({ error: `Maximum ${MAX_SESSIONS} simultaneous sessions` });
		return;
	}

	const { cwd } = req.body || {};

	// Validate cwd stays within /workspace to prevent path traversal
	if (cwd && typeof cwd === "string") {
		const WORKSPACE = process.env.WORKSPACE || "/workspace";
		const resolved = resolve(cwd);
		if (!resolved.startsWith(WORKSPACE + sep) && resolved !== WORKSPACE) {
			res.status(403).json({ error: "Access denied: cwd outside workspace" });
			return;
		}
	}

	// Guard: respond within 10s no matter what — prevents daemon proxy 504 timeout.
	let responded = false;
	const timeout = setTimeout(() => {
		if (!responded) {
			responded = true;
			console.error(`[Console] Shell creation timed out after 10s`);
			res
				.status(500)
				.json({ error: "Shell creation timed out — check server logs" });
		}
	}, 10000);

	try {
		const session = createShellSession(cwd || undefined);
		clearTimeout(timeout);
		if (responded) return; // timeout already fired
		responded = true;
		console.log(
			`[Console] Shell session created: ${session.id} (cwd: ${session.cwd})`,
		);
		broadcastStatus();
		res.json({ sessionId: session.id, cwd: session.cwd, name: session.name });
	} catch (e) {
		clearTimeout(timeout);
		if (responded) return;
		responded = true;
		const detail =
			e instanceof Error ? e.message : "Failed to create shell session";
		console.log(`[Console] Shell session creation failed: ${detail}`);
		res.status(400).json({ error: "Failed to create shell session" });
	}
});

// List active console sessions
router.get("/sessions", (_req, res) => {
	res.json({ sessions: listSessions() });
});

// Check if a directory has resumable conversations
router.get("/has-conversations", async (req, res) => {
	const cwd = req.query.cwd as string;
	if (!cwd) {
		res.status(400).json({ error: "cwd query param required" });
		return;
	}
	// Validate cwd stays within workspace
	const WORKSPACE = process.env.WORKSPACE || "/workspace";
	const resolved = resolve(cwd);
	if (!resolved.startsWith(WORKSPACE + sep) && resolved !== WORKSPACE) {
		res.status(403).json({ error: "Access denied: cwd outside workspace" });
		return;
	}
	res.json({ hasConversations: await hasResumableConversations(cwd) });
});

// List recent conversations across all projects (for resume UI)
// Two-pass approach: stat all files (cheap), sort by mtime, only read top N (expensive).
// This avoids reading all 1000+ .jsonl files just to find the 5 most recent.
const RECENT_LIMIT = 5;
const RECENT_READ_CANDIDATES = 20; // read a few extra in case some lack title/cwd

router.get("/recent-conversations", (_req, res) => {
	try {
		const home = process.env.HOME || "/root";
		const projectsDir = `${home}/.claude/projects`;
		if (!existsSync(projectsDir)) {
			res.json({ conversations: [] });
			return;
		}

		// Pass 1: collect file paths + mtimes (no content reads)
		// Only include project directories whose decoded path exists inside the
		// container. Conversations from external Claude Code processes (e.g. running
		// from /home/user/...) use a different project dir encoding and can't be
		// resumed from inside the container — skip them entirely.
		const WORKSPACE = process.env.WORKSPACE || "/workspace";
		const candidates: Array<{ id: string; filePath: string; mtime: number }> =
			[];

		for (const projectDir of readdirSync(projectsDir)) {
			const fullDir = join(projectsDir, projectDir);
			try {
				if (!statSync(fullDir).isDirectory()) continue;
			} catch {
				continue;
			}

			// Decode project dir name: "-workspace-codeck" → "/workspace/codeck"
			const decodedPath = "/" + projectDir.replace(/^-/, "").replace(/-/g, "/");
			if (
				!decodedPath.startsWith(WORKSPACE + "/") &&
				decodedPath !== WORKSPACE
			) {
				continue; // skip — from external process, can't resume
			}

			for (const file of readdirSync(fullDir)) {
				if (!file.endsWith(".jsonl")) continue;
				const filePath = join(fullDir, file);
				try {
					const mtime = statSync(filePath).mtimeMs;
					candidates.push({
						id: basename(file, ".jsonl"),
						filePath,
						mtime,
					});
				} catch {
					/* stat failed — skip */
				}
			}
		}

		// Sort by mtime descending — most recent first
		candidates.sort((a, b) => b.mtime - a.mtime);

		// Pass 2: read only the top N candidates to extract title + cwd
		const convos: Array<{
			id: string;
			title: string;
			cwd: string;
			mtime: number;
		}> = [];

		for (const c of candidates.slice(0, RECENT_READ_CANDIDATES)) {
			if (convos.length >= RECENT_LIMIT) break;

			let title = "";
			let cwd = "";
			let sessionId = "";
			try {
				const content = readFileSync(c.filePath, "utf-8");
				for (const line of content.split("\n").slice(0, 30)) {
					if (!line.trim()) continue;
					const d = JSON.parse(line);
					// Extract sessionId from any entry that has it (needed for --resume)
					if (!sessionId && d.sessionId) {
						sessionId = d.sessionId;
					}
					if (d.type === "user" && !title) {
						cwd = d.cwd || "";
						if (!sessionId && d.sessionId) sessionId = d.sessionId;
						const msg = d.message;
						if (msg && typeof msg === "object") {
							const ct = msg.content;
							if (Array.isArray(ct)) {
								for (const block of ct) {
									if (block?.type === "text" && block.text) {
										title = block.text
											.replace(/<[^>]*>/g, "")
											.trim()
											.slice(0, 80);
										break;
									}
								}
							} else if (typeof ct === "string") {
								title = ct
									.replace(/<[^>]*>/g, "")
									.trim()
									.slice(0, 80);
							}
						}
						if (title && sessionId) break;
					}
				}
			} catch {
				/* non-fatal */
			}

			// sessionId is what --resume needs; fall back to file-based id
			const resumeId = sessionId || c.id;
			if (title && cwd) {
				// Remap paths from the host or older container layout to current /workspace
				let resolvedCwd = cwd;
				if (!existsSync(resolvedCwd)) {
					const parts = resolvedCwd.split("/");
					const projectName = parts[parts.length - 1];
					const candidate = join(WORKSPACE, projectName);
					if (projectName && existsSync(candidate)) {
						resolvedCwd = candidate;
					} else if (existsSync(WORKSPACE)) {
						resolvedCwd = WORKSPACE;
					}
				}
				convos.push({ id: resumeId, title, cwd: resolvedCwd, mtime: c.mtime });
			}
		}

		res.json({ conversations: convos });
	} catch (e) {
		console.warn(
			"[Console] Failed to list recent conversations:",
			(e as Error).message,
		);
		res.json({ conversations: [] });
	}
});

// Resume a specific conversation by ID
router.post("/resume", (req, res) => {
	if (!isClaudeAuthenticated()) {
		res.status(400).json({ error: "Claude is not authenticated" });
		return;
	}
	if (getSessionCount() >= MAX_SESSIONS) {
		res
			.status(400)
			.json({ error: `Maximum ${MAX_SESSIONS} simultaneous sessions` });
		return;
	}

	const { conversationId, cwd } = req.body || {};
	if (!conversationId || typeof conversationId !== "string") {
		res.status(400).json({ error: "conversationId required" });
		return;
	}
	// Validate UUID format to prevent CLI flag injection
	const UUID_RE =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	if (!UUID_RE.test(conversationId)) {
		res.status(400).json({ error: "Invalid conversationId format" });
		return;
	}

	// Validate cwd stays within /workspace (same check as /create)
	if (cwd && typeof cwd === "string") {
		const WORKSPACE = process.env.WORKSPACE || "/workspace";
		const resolved = resolve(cwd);
		if (!resolved.startsWith(WORKSPACE + sep) && resolved !== WORKSPACE) {
			res.status(403).json({ error: "Access denied: cwd outside workspace" });
			return;
		}
	}

	try {
		const session = createConsoleSession({
			cwd: cwd || undefined,
			resume: true,
			conversationId,
		});
		console.log(
			`[Console] Session resumed: ${session.id} (conversation: ${conversationId}, cwd: ${session.cwd})`,
		);
		broadcastStatus();
		res.json({ sessionId: session.id, cwd: session.cwd, name: session.name });
	} catch (e) {
		const detail = e instanceof Error ? e.message : "Failed to resume conversation";
		console.error(`[Console] Resume failed: ${detail} (conversation: ${conversationId}, cwd: ${cwd})`);
		res.status(400).json({ error: detail });
	}
});

// Rename console session
router.post("/rename", (req, res) => {
	const { sessionId, name } = req.body;
	if (!sessionId || typeof name !== "string") {
		res.status(400).json({ error: "sessionId and name required" });
		return;
	}
	// Strip HTML tags to prevent stored XSS when displayed in frontend
	const sanitized = name.replace(/<[^>]*>/g, "").trim();
	if (!sanitized || sanitized.length > 200) {
		res.status(400).json({ error: "Name must be 1-200 characters (no HTML)" });
		return;
	}
	const ok = renameSession(sessionId, sanitized);
	if (!ok) {
		res.status(404).json({ error: "Session not found" });
		return;
	}
	res.json({ success: true });
});

// Resize console
router.post("/resize", (req, res) => {
	const { sessionId, cols, rows } = req.body;
	if (!sessionId || typeof cols !== "number" || typeof rows !== "number") {
		res
			.status(400)
			.json({ error: "sessionId, cols (number), rows (number) required" });
		return;
	}
	if (cols < 1 || cols > 500 || rows < 1 || rows > 200) {
		res.status(400).json({ error: "cols must be 1-500, rows must be 1-200" });
		return;
	}
	resizeSession(sessionId, cols, rows);
	res.json({ success: true });
});

// Context usage — per-session, from statusline.sh
const contextBySession = new Map<
	string,
	{
		contextPercent: number;
		contextTokens: number;
		contextWindow: number;
		model: string;
		updatedAt: number;
	}
>();

// Destroy console session
router.post("/destroy", (req, res) => {
	const { sessionId } = req.body;
	if (!sessionId) {
		res.status(400).json({ error: "sessionId required" });
		return;
	}
	destroySession(sessionId);
	contextBySession.delete(sessionId);
	console.log(`[Console] Session destroyed: ${sessionId}`);
	broadcastStatus();
	res.json({ success: true });
});

router.post("/context", (req, res) => {
	const { contextPercent, contextTokens, contextWindow, model, sessionId } =
		req.body;
	const data = {
		contextPercent: contextPercent || 0,
		contextTokens: contextTokens || 0,
		contextWindow: contextWindow || 0,
		model: model || "",
		updatedAt: Date.now(),
	};
	if (sessionId) {
		contextBySession.set(sessionId, data);
		broadcast({ type: "context", data: { ...data, sessionId } });
	}
	// Silently ignore context without sessionId (e.g., shell sessions)
	res.json({ ok: true });
});

router.get("/context", (req, res) => {
	const sid = req.query.sessionId as string;
	const data = sid ? contextBySession.get(sid) : null;
	res.json(
		data || {
			contextPercent: 0,
			contextTokens: 0,
			contextWindow: 0,
			model: "",
			updatedAt: 0,
		},
	);
});

// ── Subagent tracking — real-time panel for background sub-agents ──

import { watch, type FSWatcher } from "fs";
import { readFile } from "fs/promises";

interface ActiveSubagent {
	agentId: string;
	agentType: string;
	sessionId: string;
	cwd: string;
	transcriptPath: string;
	startedAt: number;
	lastLine: string;
	linesRead: number;
}

const activeSubagents = new Map<string, ActiveSubagent>();
const transcriptWatchers = new Map<string, FSWatcher>();

// Auto-expire stale subagents (hook may fail to deliver SubagentStop)
const SUBAGENT_MAX_AGE_MS = 10 * 60 * 1000; // 10 min
setInterval(() => {
	const now = Date.now();
	for (const [id, agent] of activeSubagents) {
		if (now - agent.startedAt > SUBAGENT_MAX_AGE_MS) {
			stopTranscriptWatch(id);
			activeSubagents.delete(id);
			broadcast({
				type: "subagent:stop",
				data: {
					agentId: id,
					agentType: agent.agentType,
					sessionId: agent.sessionId,
					duration: now - agent.startedAt,
					lastMessage: "Expired (no stop event)",
				},
			});
		}
	}
}, 30000);

/** Parse a JSONL transcript line and extract a human-readable summary */
function summarizeTranscriptLine(line: string): string | null {
	try {
		const entry = JSON.parse(line);
		if (entry.type === "progress") return null; // skip hook progress noise

		const content = entry.message?.content;
		if (!content) return null;

		// Handle array content (assistant messages)
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "tool_use" && block.name) {
					// Show tool name + brief input
					const inp = block.input || {};
					const summary =
						typeof inp === "string"
							? inp.slice(0, 120)
							: (
									inp.command ||
									inp.pattern ||
									inp.file_path ||
									inp.url ||
									inp.query ||
									inp.prompt ||
									inp.description ||
									""
								).slice(0, 120);
					return `${block.name}: ${summary || "..."}`;
				}
				if (block.type === "text" && block.text?.trim()) {
					// Skip very short text (usually just transitional)
					const text = block.text.trim();
					if (text.length > 10) return text.slice(0, 200);
				}
				// Tool results (inside user messages)
				if (block.type === "tool_result" && typeof block.content === "string") {
					return `Result: ${block.content.slice(0, 150)}`;
				}
			}
		}
		// String content (user messages — skip these)
	} catch {
		/* not valid JSON line */
	}
	return null;
}

/** Start watching a subagent's transcript file for real-time output */
function startTranscriptWatch(
	agentId: string,
	transcriptPath: string,
	retries = 0,
): void {
	if (!transcriptPath) return;
	if (transcriptWatchers.has(agentId)) return;

	// Transcript file may not exist yet — retry up to 10 times (every 1s)
	if (!existsSync(transcriptPath)) {
		if (retries < 10 && activeSubagents.has(agentId)) {
			setTimeout(
				() => startTranscriptWatch(agentId, transcriptPath, retries + 1),
				1000,
			);
		}
		return;
	}

	let lastSize = 0;
	try {
		lastSize = statSync(transcriptPath).size;
	} catch {
		/* new file */
	}

	const watcher = watch(transcriptPath, async () => {
		const agent = activeSubagents.get(agentId);
		if (!agent) {
			watcher.close();
			transcriptWatchers.delete(agentId);
			return;
		}

		try {
			const content = await readFile(transcriptPath, "utf-8");
			const lines = content.split("\n").filter((l) => l.trim());
			const newLines = lines.slice(agent.linesRead);

			for (const line of newLines) {
				const summary = summarizeTranscriptLine(line);
				if (summary) {
					agent.lastLine = summary;
					broadcast({
						type: "subagent:output",
						data: { agentId, agentType: agent.agentType, text: summary },
					});
				}
			}
			agent.linesRead = lines.length;
		} catch {
			/* file might be locked */
		}
	});

	transcriptWatchers.set(agentId, watcher);
}

/** Clean up watcher for a completed subagent */
function stopTranscriptWatch(agentId: string): void {
	const watcher = transcriptWatchers.get(agentId);
	if (watcher) {
		watcher.close();
		transcriptWatchers.delete(agentId);
	}
}

router.post("/subagents", (req, res) => {
	const {
		event,
		agentId,
		agentType,
		sessionId,
		cwd,
		transcriptPath,
		lastMessage,
	} = req.body;

	if (event === "SubagentStart") {
		activeSubagents.set(agentId, {
			agentId,
			agentType,
			sessionId,
			cwd,
			transcriptPath: transcriptPath || "",
			startedAt: Date.now(),
			lastLine: "",
			linesRead: 0,
		});

		broadcast({
			type: "subagent:start",
			data: { agentId, agentType, sessionId, cwd, startedAt: Date.now() },
		});

		// Start watching the transcript file for streaming output
		if (transcriptPath) {
			// Small delay — file may not exist yet when SubagentStart fires
			setTimeout(() => startTranscriptWatch(agentId, transcriptPath), 500);
		}
	}

	if (event === "SubagentStop") {
		const agent = activeSubagents.get(agentId);
		const duration = agent ? Date.now() - agent.startedAt : 0;

		stopTranscriptWatch(agentId);
		activeSubagents.delete(agentId);

		broadcast({
			type: "subagent:stop",
			data: {
				agentId,
				agentType,
				sessionId,
				duration,
				lastMessage: lastMessage || agent?.lastLine || "",
			},
		});
	}

	res.json({ ok: true });
});

router.get("/subagents", (_req, res) => {
	const agents = [...activeSubagents.values()].map((a) => ({
		agentId: a.agentId,
		agentType: a.agentType,
		startedAt: a.startedAt,
		lastLine: a.lastLine,
		elapsed: Date.now() - a.startedAt,
	}));
	res.json({ agents });
});

export default router;
