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
	chatModel,
	chatUseTools,
} from "../state/chat-store";
import { showToast } from "../state/store";
import { apiFetch } from "../api";

function ConversationSidebar({
	collapsed,
	onToggle,
}: {
	collapsed: boolean;
	onToggle: () => void;
}) {
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
		if (confirm("Delete this conversation? This cannot be undone.")) {
			deleteConversation(id, apiFetch);
		}
	}

	if (collapsed) {
		return (
			<div class="chat-sidebar chat-sidebar-collapsed">
				<button
					class="chat-sidebar-toggle"
					onClick={onToggle}
					title="Show conversations"
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
					>
						<rect x="3" y="3" width="18" height="18" rx="2" />
						<line x1="9" y1="3" x2="9" y2="21" />
					</svg>
				</button>
				<button
					class="chat-sidebar-toggle"
					onClick={handleNewChat}
					title="New chat"
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
					>
						<line x1="12" y1="5" x2="12" y2="19" />
						<line x1="5" y1="12" x2="19" y2="12" />
					</svg>
				</button>
			</div>
		);
	}

	return (
		<div class="chat-sidebar">
			<div class="chat-sidebar-header">
				<button class="chat-sidebar-new" onClick={handleNewChat}>
					+ New Chat
				</button>
				<button
					class="chat-sidebar-toggle"
					onClick={onToggle}
					title="Hide conversations"
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
					>
						<rect x="3" y="3" width="18" height="18" rx="2" />
						<line x1="9" y1="3" x2="9" y2="21" />
					</svg>
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
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
	const [attachments, setAttachments] = useState<File[]>([]);
	const messagesRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	const messages = chatMessages.value;
	const streaming = chatStreaming.value;
	const isEmpty = messages.length === 0;

	// Fetch conversations on mount + reload active conversation if messages lost
	useEffect(() => {
		fetchConversations(apiFetch);
		// If we had an active conversation but messages are gone (navigated away and back),
		// reload from server — but NOT if actively streaming (messages live in memory)
		const convId = activeConversationId.value;
		if (convId && chatMessages.value.length === 0 && !chatStreaming.value) {
			loadConversation(convId, apiFetch);
		}
	}, []);

	// Auto-scroll on new messages
	useEffect(() => {
		if (messagesRef.current) {
			messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
		}
	}, [messages.length, messages[messages.length - 1]?.content]);

	function handleFileSelect(e: Event) {
		const files = (e.target as HTMLInputElement).files;
		if (!files) return;
		const newFiles = Array.from(files).slice(0, 5); // max 5 files
		setAttachments((prev) => [...prev, ...newFiles].slice(0, 5));
		if (fileInputRef.current) fileInputRef.current.value = "";
	}

	function removeAttachment(idx: number) {
		setAttachments((prev) => prev.filter((_, i) => i !== idx));
	}

	async function handleSend() {
		const text = input.trim();
		if (!text && attachments.length === 0) return;
		if (streaming) return;
		setInput("");

		// Build message with file contents appended
		let fullMessage = text;
		if (attachments.length > 0) {
			const fileParts: string[] = [];
			for (const file of attachments) {
				try {
					const content = await file.text();
					fileParts.push(
						`--- File: ${file.name} (${(file.size / 1024).toFixed(0)} KB) ---\n${content}`,
					);
				} catch {
					fileParts.push(`--- File: ${file.name} (failed to read) ---`);
				}
			}
			fullMessage = text + "\n\n" + fileParts.join("\n\n");
			setAttachments([]);
		}

		const isNewConversation = activeConversationId.value === null;
		addUserMessage(fullMessage);

		try {
			const res = await apiFetch("/api/chat/message", {
				method: "POST",
				body: JSON.stringify({
					message: fullMessage,
					conversationId: activeConversationId.value,
					model: chatModel.value,
					useTools: chatUseTools.value,
				}),
			});
			const data = await res.json();
			if (data.chatId) {
				addAssistantMessage(data.chatId);
			}
			// Set the active conversation ID so subsequent messages go to the same conversation
			if (data.conversationId) {
				activeConversationId.value = data.conversationId;
			}
			// After first message in a new conversation, refresh the list
			if (isNewConversation && data.conversationId) {
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
				<ConversationSidebar
					collapsed={sidebarCollapsed}
					onToggle={() => setSidebarCollapsed((c) => !c)}
				/>
				<div class="chat-main">
					<div class="chat-empty">
						<div class="chat-greeting">
							<span class="chat-sparkle">{"\u2726"}</span>
							<h1>Hello</h1>
						</div>
						<p class="chat-subtitle">How can I help you today?</p>
						<div class="chat-input-wrap chat-input-centered">
							<input
								ref={fileInputRef}
								type="file"
								multiple
								accept=".txt,.md,.csv,.json,.xml,.html,.css,.js,.ts,.py,.sh,.yml,.yaml,.toml,.ini,.cfg,.log,.pdf,.doc,.docx"
								style="display:none"
								onChange={handleFileSelect}
							/>
							<button
								class="chat-attach-btn"
								onClick={() => fileInputRef.current?.click()}
								title="Attach files"
							>
								<svg
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
								>
									<line x1="12" y1="5" x2="12" y2="19" />
									<line x1="5" y1="12" x2="19" y2="12" />
								</svg>
							</button>
							<textarea
								ref={inputRef}
								class="chat-input"
								placeholder="Ask anything..."
								value={input}
								onInput={(e) =>
									setInput((e.target as HTMLTextAreaElement).value)
								}
								onKeyDown={handleKeyDown}
								rows={2}
							/>
							<ToolsToggle />
							<ChatModelSelector />
							<button
								class="chat-send"
								onClick={handleSend}
								disabled={!input.trim() && attachments.length === 0}
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
			{mobileSidebarOpen && (
				<div
					class="chat-mobile-overlay"
					onClick={() => setMobileSidebarOpen(false)}
				/>
			)}
			<div
				class={`chat-sidebar-wrap${mobileSidebarOpen ? " mobile-open" : ""}`}
			>
				<ConversationSidebar
					collapsed={sidebarCollapsed && !mobileSidebarOpen}
					onToggle={() => {
						if (mobileSidebarOpen) setMobileSidebarOpen(false);
						else setSidebarCollapsed((c) => !c);
					}}
				/>
			</div>
			<div class="chat-main">
				<div class="chat-header">
					<button
						class="chat-mobile-toggle"
						onClick={() => setMobileSidebarOpen(true)}
						title="Conversations"
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
						>
							<rect x="3" y="3" width="7" height="18" rx="1" />
							<rect x="14" y="3" width="7" height="18" rx="1" />
						</svg>
					</button>
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
				{attachments.length > 0 && (
					<div class="chat-attachments">
						{attachments.map((f, i) => (
							<span key={i} class="chat-attachment-pill">
								{f.name}
								<button
									class="chat-attachment-remove"
									onClick={() => removeAttachment(i)}
								>
									×
								</button>
							</span>
						))}
					</div>
				)}
				<div class="chat-input-wrap">
					<input
						ref={fileInputRef}
						type="file"
						multiple
						accept=".txt,.md,.csv,.json,.xml,.html,.css,.js,.ts,.py,.sh,.yml,.yaml,.toml,.ini,.cfg,.log,.pdf,.doc,.docx"
						style="display:none"
						onChange={handleFileSelect}
					/>
					<button
						class="chat-attach-btn"
						onClick={() => fileInputRef.current?.click()}
						title="Attach files"
						disabled={streaming}
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
						>
							<line x1="12" y1="5" x2="12" y2="19" />
							<line x1="5" y1="12" x2="19" y2="12" />
						</svg>
					</button>
					<textarea
						ref={inputRef}
						class="chat-input"
						placeholder={
							streaming ? "Waiting for response..." : "Type a message..."
						}
						value={input}
						onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
						onKeyDown={handleKeyDown}
						rows={2}
						disabled={streaming}
					/>
					<ToolsToggle />
					<ChatModelSelector />
					<button
						class="chat-send"
						onClick={handleSend}
						disabled={(!input.trim() && attachments.length === 0) || streaming}
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
	// Initialize with real elapsed time (not 0) to avoid flash on re-mount
	const [elapsed, setElapsed] = useState(() =>
		startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
	);

	useEffect(() => {
		if (!startedAt) return;
		// Set immediately to avoid 1s delay
		setElapsed(Math.floor((Date.now() - startedAt) / 1000));
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

// ── Helper: model selector ──
const CHAT_MODELS = [
	{ id: "haiku" as const, label: "Haiku", desc: "Fast" },
	{ id: "sonnet" as const, label: "Sonnet", desc: "Balanced" },
	{ id: "opus" as const, label: "Opus", desc: "Best" },
];

function ChatModelSelector() {
	const [open, setOpen] = useState(false);
	const current =
		CHAT_MODELS.find((m) => m.id === chatModel.value) || CHAT_MODELS[0];

	return (
		<div class="chat-model-selector">
			<button class="chat-model-btn" onClick={() => setOpen(!open)}>
				{current.label} <span class="chat-model-chevron">▾</span>
			</button>
			{open && (
				<div class="chat-model-dropdown">
					{CHAT_MODELS.map((m) => (
						<button
							key={m.id}
							class={`chat-model-option${m.id === chatModel.value ? " active" : ""}`}
							onClick={() => {
								chatModel.value = m.id;
								setOpen(false);
							}}
						>
							<span>{m.label}</span>
							<span class="chat-model-desc">{m.desc}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

// ── Helper: tools toggle ──
function ToolsToggle() {
	const active = chatUseTools.value;
	return (
		<button
			class={`chat-tools-toggle${active ? " active" : ""}`}
			onClick={() => {
				chatUseTools.value = !chatUseTools.value;
			}}
			title={
				active
					? "Tools enabled — can modify files"
					: "Chat only — toggle to enable file access"
			}
		>
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
			>
				<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
			</svg>
			{active ? "Tools" : "Chat"}
		</button>
	);
}
