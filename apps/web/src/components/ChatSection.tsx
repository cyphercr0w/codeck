import { useState, useRef, useEffect, useMemo } from "preact/hooks";
import {
	chatMessages,
	chatStreaming,
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
} from "../state/chat-store";
import { showToast } from "../state/store";
import { apiFetch } from "../api";
import { marked } from "marked";
import DOMPurify from "dompurify";

// Configure marked for security and GFM support
marked.setOptions({
	breaks: true,
	gfm: true,
});

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
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const editRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (editingId && editRef.current) {
			editRef.current.focus();
			editRef.current.select();
		}
	}, [editingId]);

	function handleNewChat() {
		clearChat(apiFetch);
		onToggle(); // collapse sidebar after action
	}

	function handleSelect(id: string) {
		if (id === activeId) return;
		loadConversation(id, apiFetch);
		onToggle(); // collapse sidebar after selecting
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

	async function handleDelete(e: Event, id: string) {
		e.stopPropagation();
		if (deletingId) return;
		if (!confirm("Delete this conversation?")) return;
		setDeletingId(id);
		await deleteConversation(id, apiFetch);
		setDeletingId(null);
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
			{convList.length > 0 && <div class="chat-sidebar-subtitle">Recents</div>}
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
							disabled={deletingId === c.id}
						>
							{deletingId === c.id ? (
								<span class="spinner-sm" />
							) : (
								<svg
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
								>
									<path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14" />
								</svg>
							)}
						</button>
					</div>
				))}
				{convList.length === 0 && (
					<div class="chat-sidebar-empty">No conversations yet</div>
				)}
			</div>
		</div>
	);
}

export function ChatSection() {
	const [input, setInput] = useState("");
	const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
		try {
			return localStorage.getItem("chat-sidebar-collapsed") === "true";
		} catch {
			return false;
		}
	});
	const toggleSidebarCollapsed = () => {
		setSidebarCollapsed((c) => {
			const next = !c;
			try {
				localStorage.setItem("chat-sidebar-collapsed", String(next));
			} catch {}
			return next;
		});
	};
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

	// Scroll to bottom when input is focused (mobile keyboard opens)
	function handleInputFocus() {
		setTimeout(() => {
			if (messagesRef.current) {
				messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
			}
		}, 300); // wait for keyboard to appear
	}

	const TEXT_EXTENSIONS = new Set([
		".txt",
		".md",
		".csv",
		".json",
		".xml",
		".html",
		".css",
		".js",
		".ts",
		".py",
		".sh",
		".yml",
		".yaml",
		".toml",
		".ini",
		".cfg",
		".log",
		".jsx",
		".tsx",
		".rs",
		".go",
		".java",
		".rb",
		".php",
		".sql",
		".env",
		".gitignore",
	]);

	function isTextFile(file: File): boolean {
		if (file.type.startsWith("text/")) return true;
		if (file.type === "application/json" || file.type === "application/xml")
			return true;
		const ext = "." + file.name.split(".").pop()?.toLowerCase();
		return TEXT_EXTENSIONS.has(ext);
	}

	function handleFileSelect(e: Event) {
		const files = (e.target as HTMLInputElement).files;
		if (!files) return;
		const allFiles = Array.from(files);
		const textFiles = allFiles.filter(isTextFile);
		const rejected = allFiles.length - textFiles.length;
		if (rejected > 0) {
			showToast(
				`${rejected} file(s) skipped — only text files are supported in chat`,
				"error",
			);
		}
		const newFiles = textFiles.slice(0, 5);
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

	// Quick action chips removed per user request

	// ── Attachment chips shared between empty + non-empty states ──
	function AttachmentChips() {
		if (attachments.length === 0) return null;
		return (
			<div class="chat-attachments">
				{attachments.map((f, i) => {
					const ext = f.name.includes(".")
						? f.name.split(".").pop()!.toLowerCase().slice(0, 4)
						: "file";
					const sizeLabel =
						f.size < 1024
							? `${f.size} B`
							: f.size < 1024 * 1024
								? `${(f.size / 1024).toFixed(0)} KB`
								: `${(f.size / (1024 * 1024)).toFixed(1)} MB`;
					return (
						<span
							key={`${f.name}-${f.size}-${f.lastModified}`}
							class="chat-attachment-pill"
						>
							<span class="chat-attachment-ext">{ext}</span>
							<span class="chat-attachment-name" title={f.name}>
								{f.name.length > 24 ? f.name.slice(0, 22) + "…" : f.name}
							</span>
							<span class="chat-attachment-size">{sizeLabel}</span>
							<button
								class="chat-attachment-remove"
								onClick={() => removeAttachment(i)}
								title="Remove"
							>
								×
							</button>
						</span>
					);
				})}
			</div>
		);
	}

	if (isEmpty) {
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
							else toggleSidebarCollapsed();
						}}
					/>
				</div>
				<div class="chat-main">
					{conversations.value.length > 0 && (
						<div class="chat-header chat-header-empty">
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
									<rect x="3" y="3" width="18" height="18" rx="2" />
									<line x1="9" y1="3" x2="9" y2="21" />
								</svg>
							</button>
							<span class="chat-header-title">
								{conversations.value.length} conversation
								{conversations.value.length !== 1 ? "s" : ""}
							</span>
						</div>
					)}
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
								accept=".txt,.md,.csv,.json,.xml,.html,.css,.js,.ts,.py,.sh,.yml,.yaml,.toml,.ini,.cfg,.log,.jsx,.tsx,.rs,.go,.java,.rb,.php,.sql,.env,.gitignore"
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
								onFocus={handleInputFocus}
								rows={3}
							/>
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
						<AttachmentChips />
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
						else toggleSidebarCollapsed();
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
							<rect x="3" y="3" width="18" height="18" rx="2" />
							<line x1="9" y1="3" x2="9" y2="21" />
						</svg>
					</button>
					<span class="chat-header-title">Chat</span>
					<button
						class="chat-new-btn"
						onClick={() => {
							clearChat(apiFetch);
						}}
					>
						+ New Chat
					</button>
				</div>
				<div class="chat-messages" ref={messagesRef}>
					{messages.map((m) => {
						return (
							<div key={m.id} class={`chat-msg chat-msg-${m.role}`}>
								{m.role === "assistant" && m.content ? (
									<MarkdownContent
										content={m.content}
										streaming={m.streaming}
										streamStartedAt={m.streamStartedAt}
									/>
								) : (
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
								)}
								{!m.streaming && m.durationMs != null && (
									<div class="chat-msg-meta">
										{formatDuration(m.durationMs)}
									</div>
								)}
							</div>
						);
					})}
				</div>
				<AttachmentChips />
				<div class="chat-input-wrap">
					<input
						ref={fileInputRef}
						type="file"
						multiple
						accept=".txt,.md,.csv,.json,.xml,.html,.css,.js,.ts,.py,.sh,.yml,.yaml,.toml,.ini,.cfg,.log,.jsx,.tsx,.rs,.go,.java,.rb,.php,.sql,.env,.gitignore"
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
						onFocus={handleInputFocus}
						rows={3}
						disabled={streaming}
					/>
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
				<div class="chat-input-footer">
					<ChatModelSelector />
				</div>
			</div>
		</div>
	);
}

// ── Markdown rendering for assistant messages ──
function MarkdownContent({
	content,
	streaming,
	streamStartedAt,
}: {
	content: string;
	streaming?: boolean;
	streamStartedAt?: number;
}) {
	// Parse markdown and sanitize with DOMPurify to prevent XSS
	const html = useMemo(() => {
		const raw = marked.parse(content);
		// marked.parse can return string | Promise<string>; we only use sync mode
		if (typeof raw !== "string") return "";
		return DOMPurify.sanitize(raw);
	}, [content]);

	return (
		<div class="chat-msg-content markdown-body">
			{streaming && !content && (
				<span class="chat-thinking">
					<span class="spinner-sm" />
					<ElapsedTimer startedAt={streamStartedAt} />
				</span>
			)}
			{/* Content is sanitized via DOMPurify.sanitize() above */}
			<div dangerouslySetInnerHTML={{ __html: html }} />
			{streaming && content && <span class="chat-cursor">{"\u2588"}</span>}
		</div>
	);
}

// ── Helper components ──
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
	const containerRef = useRef<HTMLDivElement>(null);
	const current =
		CHAT_MODELS.find((m) => m.id === chatModel.value) || CHAT_MODELS[0];

	// Close dropdown on outside click
	useEffect(() => {
		if (!open) return;
		function handleClickOutside(e: MouseEvent) {
			if (
				containerRef.current &&
				!containerRef.current.contains(e.target as Node)
			) {
				setOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [open]);

	return (
		<div class="chat-model-selector" ref={containerRef}>
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
