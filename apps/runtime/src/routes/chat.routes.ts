import { Router } from "express";
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	readdirSync,
	unlinkSync,
	existsSync,
} from "fs";
import { join } from "path";
import { broadcast } from "../web/logger.js";
import {
	buildCleanEnv,
	getOAuthEnv,
	getValidAgentBinary,
} from "../services/claude-env.js";

const router = Router();

// --- Conversation persistence ---

interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

interface ChatConversation {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messages: ChatMessage[];
}

const CONVERSATIONS_DIR = "/workspace/.codeck/chat/conversations";

function ensureConversationsDir(): void {
	mkdirSync(CONVERSATIONS_DIR, { recursive: true });
}

function conversationPath(id: string): string {
	// Sanitize id to prevent path traversal
	const safeId = id.replace(/[^a-zA-Z0-9\-]/g, "");
	return join(CONVERSATIONS_DIR, `${safeId}.json`);
}

function readConversation(id: string): ChatConversation | null {
	const filePath = conversationPath(id);
	if (!existsSync(filePath)) return null;
	try {
		const data = readFileSync(filePath, "utf-8");
		return JSON.parse(data) as ChatConversation;
	} catch {
		return null;
	}
}

function writeConversation(conversation: ChatConversation): void {
	ensureConversationsDir();
	const filePath = conversationPath(conversation.id);
	writeFileSync(filePath, JSON.stringify(conversation, null, 2), {
		mode: 0o600,
	});
}

function autoName(message: string): string {
	return message.slice(0, 50).replace(/\n/g, " ").trim() || "Untitled";
}

function listAllConversations(): Array<{
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}> {
	ensureConversationsDir();
	const files = readdirSync(CONVERSATIONS_DIR).filter((f) =>
		f.endsWith(".json"),
	);
	const conversations = files
		.map((f) => {
			try {
				const data = readFileSync(join(CONVERSATIONS_DIR, f), "utf-8");
				const conv = JSON.parse(data) as ChatConversation;
				return {
					id: conv.id,
					name: conv.name,
					createdAt: conv.createdAt,
					updatedAt: conv.updatedAt,
					messageCount: conv.messages.length,
				};
			} catch {
				return null;
			}
		})
		.filter((c): c is NonNullable<typeof c> => c !== null);
	// Sort newest first
	conversations.sort(
		(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
	);
	return conversations;
}

// Active chat processes (for cancellation)
const activeChatProcesses = new Map<string, ChildProcess>();

// POST /api/chat/message — Send a message and get streaming response
// Returns immediately with chatId, streams response via WS events:
//   chat:response:chunk { chatId, chunk }
//   chat:response:complete { chatId, fullResponse }
// Accepts optional conversationId to append to an existing conversation
router.post("/message", (req, res) => {
	const { message, context, conversationId, model, useTools } = req.body;
	if (!message || typeof message !== "string") {
		res.status(400).json({ error: "message (string) is required" });
		return;
	}
	if (message.length > 50000) {
		res.status(400).json({ error: "Message too long (max 50,000 chars)" });
		return;
	}

	// Validate context if provided
	const safeContext =
		typeof context === "string" && context.length <= 50000 ? context : "";

	const chatId = randomUUID();
	const now = new Date().toISOString();

	// Resolve or create conversation
	let conversation: ChatConversation;
	if (conversationId && typeof conversationId === "string") {
		const existing = readConversation(conversationId);
		if (!existing) {
			res.status(404).json({ error: "Conversation not found" });
			return;
		}
		conversation = existing;
	} else {
		conversation = {
			id: randomUUID(),
			name: autoName(message),
			createdAt: now,
			updatedAt: now,
			messages: [],
		};
	}

	// Append user message to conversation
	const userMessage: ChatMessage = {
		id: randomUUID(),
		role: "user",
		content: message,
		timestamp: Date.now(),
	};
	conversation.messages.push(userMessage);
	conversation.updatedAt = now;
	writeConversation(conversation);

	// Build prompt with conversation history for continuity
	let prompt = "";
	// Include previous messages as context (up to 10 most recent for speed)
	const prevMessages = conversation.messages.slice(-11, -1); // exclude the message we just added
	if (prevMessages.length > 0) {
		prompt += "Previous conversation:\n";
		for (const msg of prevMessages) {
			const label = msg.role === "user" ? "User" : "Assistant";
			prompt += `${label}: ${msg.content}\n\n`;
		}
		prompt += "---\n\n";
	}
	if (safeContext) {
		prompt += `${safeContext}\n\n`;
	}
	prompt += `User: ${message}`;

	// Validate model (default to haiku for fast chat)
	const MODEL_MAP: Record<string, string> = {
		haiku: "claude-haiku-4-5-20251001",
		sonnet: "claude-sonnet-4-6-20250514",
		opus: "claude-opus-4-6-20250514",
	};
	const chatModel = MODEL_MAP[model] || MODEL_MAP.haiku;

	// ── API Direct mode (no tools, fast) ──
	if (!useTools) {
		// Build messages array for the API
		const apiMessages = conversation.messages
			.slice(-11) // last 10 + current
			.map((m: ChatMessage) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			}));

		const oauthToken = getOAuthEnv().CLAUDE_CODE_OAUTH_TOKEN;
		if (!oauthToken) {
			res.status(401).json({ error: "Not authenticated" });
			return;
		}

		res.status(202).json({
			chatId,
			conversationId: conversation.id,
			status: "streaming",
		});

		// Stream via SSE from Anthropic API
		(async () => {
			try {
				const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-api-key": oauthToken,
						"anthropic-version": "2023-06-01",
					},
					body: JSON.stringify({
						model: chatModel,
						max_tokens: 4096,
						stream: true,
						system:
							"You are a helpful assistant inside Codeck, a cloud sandbox for coding. In this mode you can only answer questions and have conversations — you CANNOT read, create, edit, or delete files, run commands, or access the filesystem. If the user asks you to modify files, write code to disk, run tests, deploy, or perform any action that requires filesystem or terminal access, politely tell them: \"I can't modify files in chat mode. Toggle the 'Use tools' option in the input bar to enable file access.\" Be concise and helpful.",
						messages: apiMessages,
					}),
					signal: AbortSignal.timeout(120000),
				});

				if (!apiRes.ok || !apiRes.body) {
					broadcast({
						type: "chat:response:complete",
						data: {
							chatId,
							fullResponse: "",
							exitCode: 1,
							conversationId: conversation.id,
						},
					});
					return;
				}

				let fullResponse = "";
				const reader = apiRes.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";

					for (const line of lines) {
						if (!line.startsWith("data: ")) continue;
						const data = line.slice(6);
						if (data === "[DONE]") continue;

						try {
							const event = JSON.parse(data);
							if (event.type === "content_block_delta" && event.delta?.text) {
								fullResponse += event.delta.text;
								broadcast({
									type: "chat:response:chunk",
									data: { chatId, chunk: event.delta.text },
								});
							}
						} catch {
							/* skip unparseable */
						}
					}
				}

				// Save to conversation
				const freshConv = readConversation(conversation.id);
				if (freshConv && fullResponse.trim()) {
					freshConv.messages.push({
						id: randomUUID(),
						role: "assistant",
						content: fullResponse,
						timestamp: Date.now(),
					});
					freshConv.updatedAt = new Date().toISOString();
					writeConversation(freshConv);
				}

				broadcast({
					type: "chat:response:complete",
					data: {
						chatId,
						fullResponse,
						exitCode: 0,
						conversationId: conversation.id,
					},
				});
			} catch (err) {
				console.error(
					`[Chat] API error for ${chatId}:`,
					(err as Error).message,
				);
				broadcast({
					type: "chat:response:complete",
					data: {
						chatId,
						fullResponse: "",
						exitCode: 1,
						conversationId: conversation.id,
					},
				});
			}
		})();

		return;
	}

	// ── Agent mode (with tools, spawn CLI) ──
	const cliModel = model || "haiku"; // CLI uses short names
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
			"--model",
			cliModel,
			"--allowedTools",
			"Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch",
			"--max-turns",
			"3",
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

		// Save assistant response to conversation
		if (fullResponse.trim()) {
			const freshConv = readConversation(conversation.id);
			if (freshConv) {
				const assistantMessage: ChatMessage = {
					id: randomUUID(),
					role: "assistant",
					content: fullResponse,
					timestamp: Date.now(),
				};
				freshConv.messages.push(assistantMessage);
				freshConv.updatedAt = new Date().toISOString();
				writeConversation(freshConv);
			}
		}

		broadcast({
			type: "chat:response:complete",
			data: {
				chatId,
				fullResponse,
				exitCode: code,
				conversationId: conversation.id,
			},
		});
	});

	// Return immediately — response streams via WS
	res
		.status(202)
		.json({ chatId, conversationId: conversation.id, status: "streaming" });
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

// --- Conversation CRUD endpoints ---

// GET /api/chat/conversations — List all conversations (newest first, no messages)
router.get("/conversations", (_req, res) => {
	try {
		const conversations = listAllConversations();
		res.json({ conversations });
	} catch (err) {
		console.error("[Chat] Failed to list conversations:", err);
		res.status(500).json({ error: "Failed to list conversations" });
	}
});

// GET /api/chat/conversations/:id — Get a conversation with all messages
router.get("/conversations/:id", (req, res) => {
	const { id } = req.params;
	const conversation = readConversation(id);
	if (!conversation) {
		res.status(404).json({ error: "Conversation not found" });
		return;
	}
	res.json(conversation);
});

// POST /api/chat/conversations — Create a new empty conversation
router.post("/conversations", (req, res) => {
	const { name } = req.body;
	const now = new Date().toISOString();
	const conversation: ChatConversation = {
		id: randomUUID(),
		name:
			typeof name === "string" && name.trim()
				? name.trim().slice(0, 200)
				: "New conversation",
		createdAt: now,
		updatedAt: now,
		messages: [],
	};
	try {
		writeConversation(conversation);
		res.status(201).json({ id: conversation.id, name: conversation.name });
	} catch (err) {
		console.error("[Chat] Failed to create conversation:", err);
		res.status(500).json({ error: "Failed to create conversation" });
	}
});

// PUT /api/chat/conversations/:id/name — Rename a conversation
router.put("/conversations/:id/name", (req, res) => {
	const { id } = req.params;
	const { name } = req.body;
	if (!name || typeof name !== "string" || !name.trim()) {
		res.status(400).json({ error: "name (non-empty string) is required" });
		return;
	}
	const conversation = readConversation(id);
	if (!conversation) {
		res.status(404).json({ error: "Conversation not found" });
		return;
	}
	conversation.name = name.trim().slice(0, 200);
	conversation.updatedAt = new Date().toISOString();
	try {
		writeConversation(conversation);
		res.json({ id: conversation.id, name: conversation.name });
	} catch (err) {
		console.error("[Chat] Failed to rename conversation:", err);
		res.status(500).json({ error: "Failed to rename conversation" });
	}
});

// DELETE /api/chat/conversations/:id — Delete a conversation
router.delete("/conversations/:id", (req, res) => {
	const { id } = req.params;
	const filePath = conversationPath(id);
	if (!existsSync(filePath)) {
		res.status(404).json({ error: "Conversation not found" });
		return;
	}
	try {
		unlinkSync(filePath);
		res.json({ success: true });
	} catch (err) {
		console.error("[Chat] Failed to delete conversation:", err);
		res.status(500).json({ error: "Failed to delete conversation" });
	}
});

export default router;
