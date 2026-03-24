import { signal } from "@preact/signals";

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: number;
	chatId?: string; // links to streaming response
	streaming?: boolean;
	streamStartedAt?: number; // when streaming began (for elapsed timer)
	durationMs?: number; // total response time (set on complete)
}

export interface ChatConversation {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}

export const chatMessages = signal<ChatMessage[]>([]);
export const chatStreaming = signal(false);
export const activeChatId = signal<string | null>(null);
export const chatModel = signal<"haiku" | "sonnet" | "opus">("haiku");
export const chatUseTools = signal(false);

export const conversations = signal<ChatConversation[]>([]);
export const activeConversationId = signal<string | null>(null);
export const editingConversationName = signal<string | null>(null);

export type ApiFetchFn = (
	url: string,
	options?: RequestInit,
) => Promise<Response>;

export function addUserMessage(content: string): string {
	const id = crypto.randomUUID();
	chatMessages.value = [
		...chatMessages.value,
		{
			id,
			role: "user",
			content,
			timestamp: Date.now(),
		},
	];
	return id;
}

export function addAssistantMessage(chatId: string): void {
	chatMessages.value = [
		...chatMessages.value,
		{
			id: crypto.randomUUID(),
			role: "assistant",
			content: "",
			timestamp: Date.now(),
			streamStartedAt: Date.now(),
			chatId,
			streaming: true,
		},
	];
	activeChatId.value = chatId;
	chatStreaming.value = true;
}

export function appendToAssistant(chatId: string, chunk: string): void {
	chatMessages.value = chatMessages.value.map((m) => {
		if (m.chatId !== chatId) return m;
		// Trim leading whitespace on first chunk (claude --print often starts with \n\n)
		const text = m.content === "" ? chunk.replace(/^\s+/, "") : chunk;
		return { ...m, content: m.content + text };
	});
}

export function completeAssistant(
	chatId: string,
	exitCode = 0,
	error?: string,
): void {
	chatMessages.value = chatMessages.value.map((m) => {
		if (m.chatId !== chatId) return m;
		const durationMs = m.streamStartedAt
			? Date.now() - m.streamStartedAt
			: undefined;
		if (exitCode !== 0 && !m.content) {
			const errText = error
				? `Something went wrong: ${error}`
				: "Something went wrong. Please try again.";
			return {
				...m,
				content: errText,
				streaming: false,
				durationMs,
			};
		}
		return { ...m, streaming: false, durationMs };
	});
	chatStreaming.value = false;
	activeChatId.value = null;
}

export function clearChat(): void {
	chatMessages.value = [];
	chatStreaming.value = false;
	activeChatId.value = null;
	activeConversationId.value = null;
}

export async function fetchConversations(
	apiFetchFn: ApiFetchFn,
): Promise<void> {
	try {
		const res = await apiFetchFn("/api/chat/conversations");
		const data = await res.json();
		conversations.value = data.conversations || [];
	} catch {
		/* non-fatal */
	}
}

export async function loadConversation(
	id: string,
	apiFetchFn: ApiFetchFn,
): Promise<void> {
	try {
		const res = await apiFetchFn(`/api/chat/conversations/${id}`);
		const data = await res.json();
		if (data.messages) {
			chatMessages.value = data.messages;
			activeConversationId.value = id;
		}
	} catch {
		/* non-fatal */
	}
}

export async function renameConversation(
	id: string,
	name: string,
	apiFetchFn: ApiFetchFn,
): Promise<void> {
	try {
		await apiFetchFn(`/api/chat/conversations/${id}/name`, {
			method: "PUT",
			body: JSON.stringify({ name }),
		});
		conversations.value = conversations.value.map((c) =>
			c.id === id ? { ...c, name } : c,
		);
	} catch {
		/* non-fatal */
	}
}

export async function deleteConversation(
	id: string,
	apiFetchFn: ApiFetchFn,
): Promise<void> {
	try {
		await apiFetchFn(`/api/chat/conversations/${id}`, { method: "DELETE" });
		conversations.value = conversations.value.filter((c) => c.id !== id);
		if (activeConversationId.value === id) {
			clearChat();
		}
	} catch {
		/* non-fatal */
	}
}
