import { readFile, writeFile, mkdir, readdir, unlink } from "fs/promises";
import { join } from "path";
import type {
	ChatConversation,
	ConversationSummary,
} from "../types/chat.types.js";

export type {
	ChatMessage,
	ChatConversation,
	ConversationSummary,
} from "../types/chat.types.js";

// --- Constants ---

export const CONVERSATIONS_DIR = "/workspace/.codeck/chat/conversations";

// Map client model names to API model IDs (module-level constant)
export const MODEL_MAP: Readonly<Record<string, string>> = {
	haiku: "claude-haiku-4-5-20251001",
	sonnet: "claude-sonnet-4-5-20250514",
	opus: "claude-opus-4-0-20250115",
};

// --- Functions ---

export async function ensureConversationsDir(): Promise<void> {
	await mkdir(CONVERSATIONS_DIR, { recursive: true });
}

export function conversationPath(id: string): string {
	// Sanitize id to prevent path traversal
	const safeId = id.replace(/[^a-zA-Z0-9\-]/g, "");
	if (!safeId) throw new Error("Invalid conversation ID");
	return join(CONVERSATIONS_DIR, `${safeId}.json`);
}

/**
 * Validate that parsed JSON has the required ChatConversation shape.
 * Returns null if validation fails.
 */
function validateConversation(data: unknown): ChatConversation | null {
	if (
		typeof data !== "object" ||
		data === null ||
		typeof (data as ChatConversation).id !== "string" ||
		typeof (data as ChatConversation).name !== "string" ||
		!Array.isArray((data as ChatConversation).messages)
	) {
		return null;
	}
	return data as ChatConversation;
}

export async function readConversation(
	id: string,
): Promise<ChatConversation | null> {
	let filePath: string;
	try {
		filePath = conversationPath(id);
	} catch {
		return null;
	}
	try {
		const data = await readFile(filePath, "utf-8");
		return validateConversation(JSON.parse(data));
	} catch (err: unknown) {
		// ENOENT = file doesn't exist — return null (not an error)
		if (
			err instanceof Error &&
			"code" in err &&
			(err as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return null;
		}
		// Other errors (corrupted JSON, permissions) — also return null
		return null;
	}
}

export async function writeConversation(
	conversation: ChatConversation,
): Promise<void> {
	await ensureConversationsDir();
	const filePath = conversationPath(conversation.id);
	await writeFile(filePath, JSON.stringify(conversation, null, 2), {
		mode: 0o600,
	});
}

export async function deleteConversation(id: string): Promise<void> {
	const filePath = conversationPath(id);
	await unlink(filePath);
}

// ── Per-conversation write serialization ──
// Prevents read-modify-write race conditions on concurrent requests
const conversationLocks = new Map<string, Promise<void>>();

export function withConversationLock<T>(
	conversationId: string,
	fn: () => Promise<T>,
): Promise<T> {
	const prev = conversationLocks.get(conversationId) ?? Promise.resolve();
	const settle = prev.catch(() => {}).then(fn);
	const tail = settle.then(
		() => {},
		() => {},
	);
	conversationLocks.set(conversationId, tail);
	// Clean up when this is still the latest entry
	tail.then(() => {
		if (conversationLocks.get(conversationId) === tail) {
			conversationLocks.delete(conversationId);
		}
	});
	return settle;
}

export function autoName(message: string): string {
	return message.slice(0, 50).replace(/\n/g, " ").trim() || "Untitled";
}

export async function listAllConversations(
	limit?: number,
	offset = 0,
): Promise<ConversationSummary[]> {
	await ensureConversationsDir();
	const files = (await readdir(CONVERSATIONS_DIR)).filter((f) =>
		f.endsWith(".json"),
	);
	const conversations: ConversationSummary[] = [];
	for (const f of files) {
		try {
			const data = await readFile(join(CONVERSATIONS_DIR, f), "utf-8");
			const conv = validateConversation(JSON.parse(data));
			if (conv) {
				conversations.push({
					id: conv.id,
					name: conv.name,
					createdAt: conv.createdAt,
					updatedAt: conv.updatedAt,
					messageCount: conv.messages.length,
				});
			}
		} catch {
			// skip corrupted files
		}
	}
	// Sort newest first
	conversations.sort(
		(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
	);
	// Apply pagination
	const start = Math.max(0, offset);
	return limit !== undefined
		? conversations.slice(start, start + limit)
		: conversations.slice(start);
}
