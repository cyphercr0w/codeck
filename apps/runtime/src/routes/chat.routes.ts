import { Router } from "express";
import { randomUUID } from "crypto";
import {
	ensureConversationsDir,
	readConversation,
	writeConversation,
	deleteConversation,
	conversationPath,
	listAllConversations,
	autoName,
} from "../services/conversation-storage.js";
import type { ChatConversation, ChatMessage } from "../types/chat.types.js";
import { handleApiDirectMode } from "../services/chat-api-handler.js";
import {
	handleAgentMode,
	activeChatProcesses,
	MAX_CHAT_PROCESSES,
	cancelExecution,
} from "../services/chat-agent-handler.js";

const router = Router();

// POST /api/chat/message — Send a message and get streaming response
router.post("/message", async (req, res) => {
	const { message, context, conversationId, model, useTools } = req.body;
	if (!message || typeof message !== "string") {
		res.status(400).json({ error: "message (string) is required" });
		return;
	}
	if (message.length > 50000) {
		res.status(400).json({ error: "Message too long (max 50,000 chars)" });
		return;
	}

	// Enforce concurrency limit on active chat processes
	if (activeChatProcesses.size >= MAX_CHAT_PROCESSES) {
		res
			.status(429)
			.json({ error: "Too many concurrent chat processes. Please wait." });
		return;
	}

	await ensureConversationsDir();

	// Validate context if provided
	const safeContext =
		typeof context === "string" && context.length <= 50000 ? context : "";

	// Validate model — must be a string
	const safeModel = typeof model === "string" ? model : "";

	// Validate useTools — strict boolean check (#14)
	const agentMode = useTools === true;

	const chatId = randomUUID();
	const now = new Date().toISOString();

	// Resolve or create conversation
	let conversation: ChatConversation;
	if (conversationId && typeof conversationId === "string") {
		const existing = await readConversation(conversationId);
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

	// Append user message (immutable — #9)
	const userMessage: ChatMessage = {
		id: randomUUID(),
		role: "user",
		content: message,
		timestamp: Date.now(),
	};
	conversation = {
		...conversation,
		messages: [...conversation.messages, userMessage],
		updatedAt: now,
	};
	await writeConversation(conversation);

	// Build prompt with conversation history for continuity.
	// Use structured delimiters to prevent prompt injection via stored messages.
	let prompt = "";
	const prevMessages = conversation.messages.slice(-11, -1);
	if (prevMessages.length > 0) {
		prompt += "<conversation-history>\n";
		for (const msg of prevMessages) {
			const tag = msg.role === "user" ? "human" : "assistant";
			prompt += `<${tag}>${msg.content}</${tag}>\n`;
		}
		prompt += "</conversation-history>\n\n";
	}
	if (safeContext) {
		prompt += `<user-context>${safeContext}</user-context>\n\n`;
	}
	prompt += message;

	if (!agentMode) {
		handleApiDirectMode(res, {
			chatId,
			conversation,
			model: safeModel,
			context: safeContext,
		});
	} else {
		handleAgentMode(res, {
			chatId,
			conversation,
			prompt,
			message,
			model: safeModel,
		});
	}
});

// POST /api/chat/cancel — Cancel an active chat or flow execution
router.post("/cancel", (req, res) => {
	const { chatId, executionId } = req.body;

	// Cancel a flow execution
	if (executionId && typeof executionId === "string") {
		cancelExecution(executionId);
		res.json({ success: true });
		return;
	}

	// Validate chatId type (#7)
	if (!chatId || typeof chatId !== "string") {
		res.status(400).json({ error: "chatId (string) is required" });
		return;
	}

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

// GET /api/chat/conversations — List all conversations (newest first)
router.get("/conversations", async (_req, res) => {
	try {
		const conversations = await listAllConversations();
		res.json({ conversations });
	} catch (err) {
		console.error("[Chat] Failed to list conversations:", err);
		res.status(500).json({ error: "Failed to list conversations" });
	}
});

// GET /api/chat/conversations/:id — Get a conversation with all messages
router.get("/conversations/:id", async (req, res) => {
	const { id } = req.params;
	const conversation = await readConversation(id);
	if (!conversation) {
		res.status(404).json({ error: "Conversation not found" });
		return;
	}
	res.json(conversation);
});

// POST /api/chat/conversations — Create a new empty conversation
router.post("/conversations", async (req, res) => {
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
		await writeConversation(conversation);
		res.status(201).json({ id: conversation.id, name: conversation.name });
	} catch (err) {
		console.error("[Chat] Failed to create conversation:", err);
		res.status(500).json({ error: "Failed to create conversation" });
	}
});

// PUT /api/chat/conversations/:id/name — Rename a conversation
router.put("/conversations/:id/name", async (req, res) => {
	const { id } = req.params;
	const { name } = req.body;
	if (!name || typeof name !== "string" || !name.trim()) {
		res.status(400).json({ error: "name (non-empty string) is required" });
		return;
	}
	const conversation = await readConversation(id);
	if (!conversation) {
		res.status(404).json({ error: "Conversation not found" });
		return;
	}
	const updated: ChatConversation = {
		...conversation,
		name: name.trim().slice(0, 200),
		updatedAt: new Date().toISOString(),
	};
	try {
		await writeConversation(updated);
		res.json({ id: updated.id, name: updated.name });
	} catch (err) {
		console.error("[Chat] Failed to rename conversation:", err);
		res.status(500).json({ error: "Failed to rename conversation" });
	}
});

// DELETE /api/chat/conversations/:id — Delete a conversation (#13: try/catch for conversationPath)
router.delete("/conversations/:id", async (req, res) => {
	const { id } = req.params;
	try {
		conversationPath(id); // validate ID format
	} catch {
		res.status(400).json({ error: "Invalid conversation ID" });
		return;
	}
	try {
		await deleteConversation(id);
		res.json({ success: true });
	} catch (err: unknown) {
		if (
			err instanceof Error &&
			"code" in err &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			res.status(404).json({ error: "Conversation not found" });
			return;
		}
		console.error("[Chat] Failed to delete conversation:", err);
		res.status(500).json({ error: "Failed to delete conversation" });
	}
});

export default router;
