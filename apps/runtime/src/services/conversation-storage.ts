import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	readdirSync,
	existsSync,
} from "fs";
import { join } from "path";

// --- Types ---

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

export interface ChatConversation {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messages: ChatMessage[];
	flowExecutionId?: string;
	flowStatus?: string;
}

// --- Constants ---

export const CONVERSATIONS_DIR = "/workspace/.codeck/chat/conversations";

// Map client model names to API model IDs (module-level constant)
export const MODEL_MAP: Readonly<Record<string, string>> = {
	haiku: "claude-haiku-4-5-20251001",
	sonnet: "claude-sonnet-4-5-20250514",
	opus: "claude-opus-4-0-20250115",
};

// --- Functions ---

export function ensureConversationsDir(): void {
	mkdirSync(CONVERSATIONS_DIR, { recursive: true });
}

export function conversationPath(id: string): string {
	// Sanitize id to prevent path traversal
	const safeId = id.replace(/[^a-zA-Z0-9\-]/g, "");
	if (!safeId) throw new Error("Invalid conversation ID");
	return join(CONVERSATIONS_DIR, `${safeId}.json`);
}

export function readConversation(id: string): ChatConversation | null {
	let filePath: string;
	try {
		filePath = conversationPath(id);
	} catch {
		return null;
	}
	if (!existsSync(filePath)) return null;
	try {
		const data = readFileSync(filePath, "utf-8");
		return JSON.parse(data) as ChatConversation;
	} catch {
		return null;
	}
}

export function writeConversation(conversation: ChatConversation): void {
	ensureConversationsDir();
	const filePath = conversationPath(conversation.id);
	writeFileSync(filePath, JSON.stringify(conversation, null, 2), {
		mode: 0o600,
	});
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

export function listAllConversations(): Array<{
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
