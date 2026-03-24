import { useState, useRef, useEffect } from "preact/hooks";
import {
	chatMessages,
	chatStreaming,
	activeChatId,
	addUserMessage,
	addAssistantMessage,
	clearChat,
	conversations,
	activeConversationId,
	editingConversationName,
	fetchConversations,
	loadConversation,
	renameConversation,
	deleteConversation,
} from "../state/chat-store";
import { showToast } from "../state/store";
import { apiFetch } from "../api";

function ConversationSidebar() {
	const convList = conversations.value;
	const activeId = activeConversationId.value;
	const editingId = editingConversationName.value;
	const [editName, setEditName] = useState("");
	const editRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (editingId && editRef.current) {
			editRef.current.focus();
			editRef.current.select();
		}
	}, [editingId]);

	function handleNewChat() {
		if (activeChatId.value) {
			apiFetch("/api/chat/cancel", {
				method: "POST",
				body: JSON.stringify({ chatId: activeChatId.value }),
			}).catch(() => {});
		}
		clearChat();
	}

	function handleSelect(id: string) {
		if (id === activeId) return;
		loadConversation(id, apiFetch);
	}

	function handleDoubleClick(id: string, currentName: string) {
		editingConversationName.value = id;
		setEditName(currentName);
	}

	function handleEditSave(id: string) {
		const trimmed = editName.trim();
		if (trimmed) {
			renameConversation(id, trimmed, apiFetch);
		}
		editingConversationName.value = null;
	}

	function handleEditKeyDown(e: KeyboardEvent, id: string) {
		if (e.key === "Enter") {
			e.preventDefault();
			handleEditSave(id);
		} else if (e.key === "Escape") {
			editingConversationName.value = null;
		}
	}

	function handleDelete(e: Event, id: string) {
		e.stopPropagation();
		deleteConversation(id, apiFetch);
	}

	return (
		<div class="chat-sidebar">
			<div class="chat-sidebar-header">
				<button class="chat-sidebar-new" onClick={handleNewChat}>
					+ New Chat
				</button>
			</div>
			<div class="chat-sidebar-list">
				{convList.map((c) => (
					<div
						key={c.id}
						class={`chat-sidebar-item${c.id === activeId ? " active" : ""}`}
						onClick={() => handleSelect(c.id)}
						onDblClick={() => handleDoubleClick(c.id, c.name)}
					>
						{editingId === c.id ? (
							<input
								ref={editRef}
								class="chat-sidebar-edit"
								value={editName}
								onInput={(e) =>
									setEditName((e.target as HTMLInputElement).value)
								}
								onKeyDown={(e) => handleEditKeyDown(e, c.id)}
								onBlur={() => handleEditSave(c.id)}
								onClick={(e) => e.stopPropagation()}
							/>
						) : (
							<span class="chat-sidebar-name">{c.name}</span>
						)}
						<button
							class="chat-sidebar-delete"
							onClick={(e) => handleDelete(e, c.id)}
							title="Delete conversation"
						>
							✕
						</button>
					</div>
				))}
			</div>
		</div>
	);
}

export function ChatSection() {
	const [input, setInput] = useState("");
	const messagesRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	const messages = chatMessages.value;
	const streaming = chatStreaming.value;
	const isEmpty = messages.length === 0;

	// Fetch conversations on mount
	useEffect(() => {
		fetchConversations(apiFetch);
	}, []);

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

		const isNewConversation = activeConversationId.value === null;
		addUserMessage(text);

		try {
			const res = await apiFetch("/api/chat/message", {
				method: "POST",
				body: JSON.stringify({
					message: text,
					conversationId: activeConversationId.value,
				}),
			});
			const data = await res.json();
			if (data.chatId) {
				addAssistantMessage(data.chatId);
			}
			// After first message in a new conversation, refresh the list
			if (isNewConversation) {
				fetchConversations(apiFetch);
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
			<div class="chat-layout">
				<ConversationSidebar />
				<div class="chat-main">
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
								onInput={(e) =>
									setInput((e.target as HTMLTextAreaElement).value)
								}
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
			</div>
		);
	}

	return (
		<div class="chat-layout">
			<ConversationSidebar />
			<div class="chat-main">
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
								{m.streaming && !m.content && (
									<span class="chat-thinking">
										<span class="spinner-sm" />
										<ElapsedTimer startedAt={m.streamStartedAt} />
									</span>
								)}
								{m.content}
								{m.streaming && m.content && (
									<span class="chat-cursor">{"\u2588"}</span>
								)}
							</div>
							{!m.streaming && m.durationMs != null && (
								<div class="chat-msg-meta">{formatDuration(m.durationMs)}</div>
							)}
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
		</div>
	);
}

// ── Helper: live elapsed timer ──
function ElapsedTimer({ startedAt }: { startedAt?: number }) {
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		if (!startedAt) return;
		const interval = setInterval(() => {
			setElapsed(Math.floor((Date.now() - startedAt) / 1000));
		}, 1000);
		return () => clearInterval(interval);
	}, [startedAt]);

	if (!startedAt) return <span>Thinking...</span>;
	return <span>Thinking... {elapsed}s</span>;
}

// ── Helper: format completed duration ──
function formatDuration(ms: number): string {
	if (ms < 1000) return "<1s";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}
