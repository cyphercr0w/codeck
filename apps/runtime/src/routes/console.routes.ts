import { Router } from "express";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve, sep } from "path";
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
	restoreSessionsNow,
} from "../services/console.js";
import { broadcastStatus } from "../web/websocket.js";
import { broadcast } from "../web/logger.js";
import { asyncHandler } from "../utils/async-handler.js";

const router = Router();

// Create console session (multi-session, max 5)
// Async: if token is refreshing after container restart, waits up to 10s
router.post(
	"/create",
	asyncHandler(async (req, res) => {
		if (!isClaudeAuthenticated()) {
			// Token may be refreshing after container restart — retry for up to 10s
			let authed = false;
			for (let i = 0; i < 10; i++) {
				await new Promise((r) => setTimeout(r, 1000));
				if (isClaudeAuthenticated()) {
					authed = true;
					break;
				}
			}
			if (!authed) {
				res.status(400).json({ error: "Claude is not authenticated" });
				return;
			}
			console.log(
				"[Console] Auth succeeded after retry (token refresh was in progress)",
			);
		}

		if (getSessionCount() >= MAX_SESSIONS) {
			res
				.status(400)
				.json({ error: `Maximum ${MAX_SESSIONS} simultaneous sessions` });
			return;
		}

		const {
			cwd,
			resume,
			enableTeams,
			useContinue,
			extraArgs: clientExtraArgs,
		} = req.body || {};

		// Validate cwd stays within /workspace to prevent path traversal
		if (cwd && typeof cwd === "string") {
			const WORKSPACE = process.env.WORKSPACE || "/workspace";
			const resolved = resolve(cwd);
			if (!resolved.startsWith(WORKSPACE + sep) && resolved !== WORKSPACE) {
				res.status(403).json({ error: "Access denied: cwd outside workspace" });
				return;
			}
		}

		// Build extra args from feature flags + any user-provided flags
		const extraArgs: string[] = [];
		const extraEnv: Record<string, string> = {};
		if (enableTeams) {
			extraArgs.push("--teammate-mode", "tmux");
			extraEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
		}
		// Append user-provided extra args with blocklist for dangerous flags
		const BLOCKED_FLAGS = new Set([
			"--dangerously-skip-permissions",
			"--allowedTools",
			"-p",
			"--prompt",
			"--model",
			"--permission-mode",
			"--output-format",
			"--mcp-config",
			"--append-system-prompt",
			"--prefill",
		]);
		if (Array.isArray(clientExtraArgs)) {
			let skipNext = false;
			for (const arg of clientExtraArgs) {
				if (typeof arg !== "string" || arg.length > 100) continue;
				if (skipNext) {
					skipNext = false;
					continue;
				}
				if (BLOCKED_FLAGS.has(arg)) {
					skipNext = true;
					continue;
				}
				extraArgs.push(arg);
			}
		}

		try {
			const session = createConsoleSession({
				cwd: cwd || undefined,
				resume,
				useContinue: !!useContinue,
				extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
				extraEnv: Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
			});
			console.log(
				`[Console] Session created: ${session.id} (cwd: ${session.cwd}, resume: ${!!resume})`,
			);
			broadcastStatus();
			res.json({ sessionId: session.id, cwd: session.cwd, name: session.name });
		} catch (e) {
			const detail =
				e instanceof Error ? e.message : "Failed to create session";
			console.log(`[Console] Session creation failed: ${detail}`);
			res.status(400).json({ error: "Failed to create session" });
		}
	}),
);

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
router.get(
	"/has-conversations",
	asyncHandler(async (req, res) => {
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
	}),
);

// List recent project folders with resumable conversations.
// Groups by cwd folder, returns one entry per folder sorted by most recent activity.
// Frontend uses POST /continue with the folder's cwd to resume.
const RECENT_FOLDERS_LIMIT = 8;

router.get("/recent-conversations", (_req, res) => {
	try {
		const home = process.env.HOME || "/root";
		const projectsDir = `${home}/.claude/projects`;
		if (!existsSync(projectsDir)) {
			res.json({ folders: [] });
			return;
		}

		const WORKSPACE = process.env.WORKSPACE || "/workspace";

		// Map: resolvedCwd → { name, mtime, count }
		const folderMap = new Map<
			string,
			{ name: string; mtime: number; count: number }
		>();

		for (const projectDir of readdirSync(projectsDir)) {
			const fullDir = join(projectsDir, projectDir);
			try {
				if (!statSync(fullDir).isDirectory()) continue;
			} catch {
				continue;
			}

			// Decode project dir name: "-workspace-codeck" → "/workspace/codeck"
			const decodedPath = resolve(
				"/" + projectDir.replace(/^-/, "").replace(/-/g, "/"),
			);
			if (
				!decodedPath.startsWith(WORKSPACE + sep) &&
				decodedPath !== WORKSPACE
			) {
				continue;
			}

			// Resolve to actual path (handle old layouts)
			let resolvedCwd = decodedPath;
			if (!existsSync(resolvedCwd)) {
				const parts = resolvedCwd.split(sep);
				const projectName = parts[parts.length - 1];
				const candidate = join(WORKSPACE, projectName);
				if (projectName && existsSync(candidate)) {
					resolvedCwd = resolve(candidate);
				} else {
					continue; // folder doesn't exist, skip
				}
			}

			// Count .jsonl files and find most recent mtime
			let latestMtime = 0;
			let fileCount = 0;
			for (const file of readdirSync(fullDir)) {
				if (!file.endsWith(".jsonl")) continue;
				try {
					const mtime = statSync(join(fullDir, file)).mtimeMs;
					fileCount++;
					if (mtime > latestMtime) latestMtime = mtime;
				} catch {
					/* stat failed */
				}
			}

			if (fileCount === 0) continue;

			const name = resolvedCwd.split(sep).pop() || "workspace";
			const existing = folderMap.get(resolvedCwd);
			if (existing) {
				folderMap.set(resolvedCwd, {
					...existing,
					count: existing.count + fileCount,
					mtime: Math.max(existing.mtime, latestMtime),
				});
			} else {
				folderMap.set(resolvedCwd, {
					name,
					mtime: latestMtime,
					count: fileCount,
				});
			}
		}

		// Sort by mtime descending, take top N
		const folders = [...folderMap.entries()]
			.sort((a, b) => b[1].mtime - a[1].mtime)
			.slice(0, RECENT_FOLDERS_LIMIT)
			.map(([cwd, info]) => ({
				cwd,
				name: info.name,
				mtime: info.mtime,
				conversationCount: info.count,
			}));

		res.json({ folders });
	} catch (e) {
		console.warn(
			"[Console] Failed to list recent folders:",
			(e as Error).message,
		);
		res.json({ folders: [] });
	}
});

// Continue most recent conversation in a folder (--continue)
router.post("/continue", (req, res) => {
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

	const { cwd } = req.body || {};
	if (!cwd || typeof cwd !== "string") {
		res.status(400).json({ error: "cwd required" });
		return;
	}

	const WORKSPACE = process.env.WORKSPACE || "/workspace";
	const resolved = resolve(cwd);
	if (!resolved.startsWith(WORKSPACE + sep) && resolved !== WORKSPACE) {
		res.status(403).json({ error: "Access denied: cwd outside workspace" });
		return;
	}

	try {
		const session = createConsoleSession({
			cwd: resolved,
			useContinue: true,
		});
		console.log(
			`[Console] Session continued: ${session.id} (cwd: ${session.cwd})`,
		);
		broadcastStatus();
		res.json({
			sessionId: session.id,
			cwd: session.cwd,
			name: session.name,
		});
	} catch (e) {
		const detail =
			e instanceof Error ? e.message : "Failed to continue conversation";
		console.error(`[Console] Continue failed: ${detail} (cwd: ${resolved})`);
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
// Restore saved sessions — called when user clicks "Resume" in the restore prompt.
// Creates the actual PTY processes. Before this, sessions are just metadata.
router.post(
	"/restore-sessions",
	asyncHandler(async (req, res) => {
		const { sessions: savedSessions } = req.body;
		if (!Array.isArray(savedSessions) || savedSessions.length === 0) {
			res.status(400).json({ error: "sessions array required" });
			return;
		}
		try {
			const restored = await restoreSessionsNow(savedSessions);
			console.log(
				`[Console] Restored ${restored.length}/${savedSessions.length} sessions`,
			);
			broadcastStatus();
			res.json({ success: true, sessions: restored });
		} catch (e) {
			res
				.status(500)
				.json({ error: "Failed to restore: " + (e as Error).message });
		}
	}),
);

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

	// Transcript file may not exist yet — retry with backoff (up to 30s)
	if (!existsSync(transcriptPath)) {
		if (retries < 30 && activeSubagents.has(agentId)) {
			const delay = retries < 5 ? 500 : 1000; // fast retries first, then 1s
			setTimeout(
				() => startTranscriptWatch(agentId, transcriptPath, retries + 1),
				delay,
			);
		} else if (retries >= 30) {
			console.warn(
				`[Subagent] Transcript watcher gave up after 30 retries: ${agentId.slice(0, 8)} (${transcriptPath})`,
			);
		}
		return;
	}

	console.log(
		`[Subagent] Transcript watcher attached: ${agentId.slice(0, 8)} (retry ${retries})`,
	);

	// Read existing content immediately — catch output written before watcher attached
	function processTranscript(agent: {
		agentId: string;
		agentType: string;
		lastLine: string;
		linesRead: number;
	}) {
		try {
			const content = readFileSync(transcriptPath, "utf-8");
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
	}

	// Initial read — process any lines already in the file
	const agent = activeSubagents.get(agentId);
	if (agent) processTranscript(agent);

	const watcher = watch(transcriptPath, () => {
		const a = activeSubagents.get(agentId);
		if (!a) {
			watcher.close();
			transcriptWatchers.delete(agentId);
			return;
		}
		processTranscript(a);
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
			data: {
				agentId,
				agentType,
				sessionId,
				cwd,
				startedAt: Date.now(),
				lastMessage: lastMessage || "",
			},
		});

		// Start watching the transcript file for streaming output
		if (transcriptPath) {
			// Short delay — file may not exist yet when SubagentStart fires
			setTimeout(() => startTranscriptWatch(agentId, transcriptPath), 200);
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
		sessionId: a.sessionId,
		startedAt: a.startedAt,
		lastLine: a.lastLine,
		elapsed: Date.now() - a.startedAt,
	}));
	res.json({ agents });
});

export default router;
