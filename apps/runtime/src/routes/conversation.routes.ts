import { Router } from "express";
import { randomUUID } from "crypto";
import { existsSync, unlinkSync } from "fs";
import {
	listAllConversations,
	readConversation,
	writeConversation,
	conversationPath,
} from "../services/conversation-storage.js";
import type { ChatConversation } from "../services/conversation-storage.js";

const router = Router();

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
