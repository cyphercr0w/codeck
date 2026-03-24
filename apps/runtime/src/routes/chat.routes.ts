import { Router } from "express";
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { broadcast } from "../web/logger.js";
import {
	buildCleanEnv,
	getOAuthEnv,
	getValidAgentBinary,
} from "../services/claude-env.js";

const router = Router();

// Active chat processes (for cancellation)
const activeChatProcesses = new Map<string, ChildProcess>();

// POST /api/chat/message — Send a message and get streaming response
// Returns immediately with chatId, streams response via WS events:
//   chat:response:chunk { chatId, chunk }
//   chat:response:complete { chatId, fullResponse }
router.post("/message", (req, res) => {
	const { message, context } = req.body;
	if (!message || typeof message !== "string") {
		res.status(400).json({ error: "message (string) is required" });
		return;
	}
	if (message.length > 50000) {
		res.status(400).json({ error: "Message too long (max 50,000 chars)" });
		return;
	}

	const chatId = randomUUID();

	// Build prompt — include context if provided
	const prompt = context ? `${context}\n\nUser message: ${message}` : message;

	const binary = getValidAgentBinary();
	const env = { ...buildCleanEnv(), ...getOAuthEnv(), TERM: "dumb" };

	const child = spawn(
		binary,
		[
			"-p",
			prompt,
			"--output-format",
			"text",
			"--no-session-persistence",
			"--allowedTools",
			"Read,Glob,Grep,WebSearch,WebFetch",
			"--max-turns",
			"10",
		],
		{
			env,
			cwd: process.env.WORKSPACE || "/workspace",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	activeChatProcesses.set(chatId, child);

	let fullResponse = "";

	child.stdout.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		fullResponse += text;
		broadcast({ type: "chat:response:chunk", data: { chatId, chunk: text } });
	});

	child.stderr.on("data", (chunk: Buffer) => {
		console.warn(
			`[Chat] stderr for ${chatId}: ${chunk.toString().slice(0, 200)}`,
		);
	});

	// Timeout: 5 minutes max
	const timeout = setTimeout(() => {
		child.kill("SIGTERM");
		setTimeout(() => {
			if (!child.killed) child.kill("SIGKILL");
		}, 5000);
	}, 300000);

	child.on("close", (code) => {
		clearTimeout(timeout);
		activeChatProcesses.delete(chatId);
		broadcast({
			type: "chat:response:complete",
			data: { chatId, fullResponse, exitCode: code },
		});
	});

	// Return immediately — response streams via WS
	res.status(202).json({ chatId, status: "streaming" });
});

// POST /api/chat/cancel — Cancel an active chat
router.post("/cancel", (req, res) => {
	const { chatId } = req.body;
	const proc = activeChatProcesses.get(chatId);
	if (!proc) {
		res.status(404).json({ error: "Chat not found or already completed" });
		return;
	}
	proc.kill("SIGTERM");
	setTimeout(() => {
		if (!proc.killed) proc.kill("SIGKILL");
	}, 3000);
	activeChatProcesses.delete(chatId);
	res.json({ success: true });
});

export default router;
