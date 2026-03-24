import { useState, useRef, useEffect } from "preact/hooks";
import {
	chatMessages,
	chatStreaming,
	activeChatId,
	addUserMessage,
	addAssistantMessage,
	clearChat,
} from "../state/chat-store";
import { showToast } from "../state/store";
import { apiFetch } from "../api";

export function ChatSection() {
	const [input, setInput] = useState("");
	const messagesRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	const messages = chatMessages.value;
	const streaming = chatStreaming.value;
	const isEmpty = messages.length === 0;

	// Auto-scroll on new messages
	useEffect(() => {
		if (messagesRef.current) {
			messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
		}
	}, [messages.length, messages[messages.length - 1]?.content]);

	async function handleSend() {
		const text = input.trim();
		if (!text || streaming) return;
		setInput("");

		addUserMessage(text);

		try {
			const res = await apiFetch("/api/chat/message", {
				method: "POST",
				body: JSON.stringify({ message: text }),
			});
			const data = await res.json();
			if (data.chatId) {
				addAssistantMessage(data.chatId);
			}
		} catch {
			showToast("Failed to send message. Please try again.", "error");
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	}

	// Quick action chips
	const quickActions = [
		{ label: "Code", icon: "</>", prompt: "Help me write code for " },
		{ label: "Write", icon: "\u270F", prompt: "Help me write " },
		{ label: "Learn", icon: "\uD83E\uDDE0", prompt: "Explain " },
		{
			label: "New Project",
			icon: "\uD83D\uDE80",
			prompt: "I want to build a new project: ",
		},
	];

	if (isEmpty) {
		return (
			<div class="chat-section">
				<div class="chat-empty">
					<div class="chat-greeting">
						<span class="chat-sparkle">{"\u2726"}</span>
						<h1>Hello</h1>
					</div>
					<p class="chat-subtitle">How can I help you today?</p>
					<div class="chat-input-wrap chat-input-centered">
						<textarea
							ref={inputRef}
							class="chat-input"
							placeholder="Ask anything..."
							value={input}
							onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
							onKeyDown={handleKeyDown}
							rows={1}
						/>
						<button
							class="chat-send"
							onClick={handleSend}
							disabled={!input.trim()}
						>
							<svg
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
							>
								<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
							</svg>
						</button>
					</div>
					<div class="chat-quick-actions">
						{quickActions.map((a) => (
							<button
								key={a.label}
								class="chat-chip"
								onClick={() => {
									setInput(a.prompt);
									inputRef.current?.focus();
								}}
							>
								<span>{a.icon}</span> {a.label}
							</button>
						))}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div class="chat-section">
			<div class="chat-header">
				<span class="chat-header-title">Chat</span>
				<button
					class="chat-new-btn"
					onClick={() => {
						if (activeChatId.value) {
							apiFetch("/api/chat/cancel", {
								method: "POST",
								body: JSON.stringify({ chatId: activeChatId.value }),
							}).catch(() => {});
						}
						clearChat();
					}}
				>
					+ New Chat
				</button>
			</div>
			<div class="chat-messages" ref={messagesRef}>
				{messages.map((m) => (
					<div key={m.id} class={`chat-msg chat-msg-${m.role}`}>
						<div class="chat-msg-content">
							{m.content ||
								(m.streaming ? (
									<span class="chat-cursor">{"\u2588"}</span>
								) : (
									""
								))}
							{m.streaming && m.content && (
								<span class="chat-cursor">{"\u2588"}</span>
							)}
						</div>
					</div>
				))}
			</div>
			<div class="chat-input-wrap">
				<textarea
					ref={inputRef}
					class="chat-input"
					placeholder={
						streaming ? "Waiting for response..." : "Type a message..."
					}
					value={input}
					onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
					onKeyDown={handleKeyDown}
					rows={1}
					disabled={streaming}
				/>
				<button
					class="chat-send"
					onClick={handleSend}
					disabled={!input.trim() || streaming}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
					>
						<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
					</svg>
				</button>
			</div>
		</div>
	);
}
