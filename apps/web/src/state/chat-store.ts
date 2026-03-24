import { signal } from "@preact/signals";

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: number;
	chatId?: string; // links to streaming response
	streaming?: boolean;
}

export const chatMessages = signal<ChatMessage[]>([]);
export const chatStreaming = signal(false);
export const activeChatId = signal<string | null>(null);

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
			chatId,
			streaming: true,
		},
	];
	activeChatId.value = chatId;
	chatStreaming.value = true;
}

export function appendToAssistant(chatId: string, chunk: string): void {
	chatMessages.value = chatMessages.value.map((m) =>
		m.chatId === chatId ? { ...m, content: m.content + chunk } : m,
	);
}

export function completeAssistant(chatId: string, exitCode = 0): void {
	chatMessages.value = chatMessages.value.map((m) => {
		if (m.chatId !== chatId) return m;
		if (exitCode !== 0 && !m.content) {
			return {
				...m,
				content: "Something went wrong. Please try again.",
				streaming: false,
			};
		}
		return { ...m, streaming: false };
	});
	chatStreaming.value = false;
	activeChatId.value = null;
}

export function clearChat(): void {
	chatMessages.value = [];
	chatStreaming.value = false;
	activeChatId.value = null;
}
