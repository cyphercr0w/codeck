import { useState, useRef, useEffect } from "preact/hooks";
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
	chatUseTools,
	activeFlowExecution,
	archivedFlows,
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
					useTools: chatUseTools.value,
				}),
			});
			const data = await res.json();
			// Only create an assistant streaming bubble for regular chat/CLI responses,
			// not for flow executions (flows use FlowProgressMessage instead)
			if (data.chatId && data.status !== "flow-started") {
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
						<div class="chat-input-footer">
							<ToolsToggle />
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
						// Flow messages render the timeline component
						if (m.role === "flow") {
							return (
								<div key={m.id} class="chat-msg chat-msg-flow">
									<FlowProgressMessage executionId={m.flowExecutionId} />
									{!m.streaming && m.durationMs != null && (
										<div class="chat-msg-meta">
											{formatDuration(m.durationMs)}
										</div>
									)}
								</div>
							);
						}
						return (
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
									<div class="chat-msg-meta">
										{formatDuration(m.durationMs)}
									</div>
								)}
							</div>
						);
					})}
				</div>
				{attachments.length > 0 && (
					<div class="chat-attachments">
						{attachments.map((f, i) => (
							<span
								key={`${f.name}-${f.size}-${f.lastModified}`}
								class="chat-attachment-pill"
							>
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
					<ToolsToggle />
					<ChatModelSelector />
				</div>
			</div>
		</div>
	);
}

// ── Flow Progress Timeline ──
function FlowProgressMessage({ executionId }: { executionId?: string }) {
	const flow =
		activeFlowExecution.value?.executionId === executionId
			? activeFlowExecution.value
			: executionId
				? archivedFlows.value[executionId]
				: activeFlowExecution.value;
	if (!flow) return null;

	const isComplete =
		flow.status === "completed" ||
		flow.status === "failed" ||
		flow.status === "cancelled";
	const statusIcon = isComplete
		? flow.status === "completed"
			? "\u2713"
			: "\u2717"
		: "\u25B6";
	const statusClass = isComplete
		? flow.status === "completed"
			? "flow-done"
			: "flow-error"
		: "flow-running";

	return (
		<div class={`flow-progress ${statusClass}`}>
			<div class="flow-progress-header">
				<span class="flow-progress-icon">{statusIcon}</span>
				<span class="flow-progress-name">{flow.flowName}</span>
				{!isComplete && <ElapsedTimer startedAt={flow.startedAt} />}
				{isComplete && flow.startedAt && (
					<span class="flow-progress-duration">
						{formatDuration((flow.completedAt || Date.now()) - flow.startedAt)}
					</span>
				)}
			</div>
			<div class="flow-progress-steps">
				{flow.agents.map((agent, i) => {
					const isCurrentAgent = flow.currentAgentId === agent.id;
					const hasOutput = !!flow.agentOutputs[agent.id];
					const duration = flow.agentDurations[agent.id];
					const isDone =
						duration != null || (flow.currentAgentIndex > i && !isCurrentAgent);

					let stepIcon = "\u25CB"; // empty circle
					let stepClass = "flow-step-pending";
					if (isDone) {
						stepIcon = "\u2713";
						stepClass = "flow-step-done";
					} else if (isCurrentAgent) {
						stepIcon = "\u25CF"; // filled circle
						stepClass = "flow-step-active";
					}

					return (
						<div key={agent.id} class={`flow-step ${stepClass}`}>
							<div class="flow-step-header">
								<span class="flow-step-icon">{stepIcon}</span>
								<span class="flow-step-name">{agent.name}</span>
								<span class="flow-step-role">{agent.role}</span>
								{isCurrentAgent && !isDone && (
									<span class="flow-step-spinner">
										<span class="spinner-sm" />
									</span>
								)}
								{duration != null && (
									<span class="flow-step-duration">
										{formatDuration(duration)}
									</span>
								)}
							</div>
							{isCurrentAgent && hasOutput && (
								<div class="flow-step-output">
									{(flow.agentOutputs[agent.id] || "").slice(-500)}
									<span class="chat-cursor">{"\u2588"}</span>
								</div>
							)}
							{isDone && hasOutput && !isCurrentAgent && (
								<FlowStepCollapsible
									output={flow.agentOutputs[agent.id] || ""}
								/>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function FlowStepCollapsible({ output }: { output: string }) {
	const [expanded, setExpanded] = useState(false);
	const preview = output.slice(0, 150).replace(/\n/g, " ");
	return (
		<div class="flow-step-collapsible">
			<button class="flow-step-toggle" onClick={() => setExpanded(!expanded)}>
				{expanded ? "\u25BC" : "\u25B6"} {expanded ? "Hide" : "Show"} output
			</button>
			{!expanded && <div class="flow-step-preview">{preview}...</div>}
			{expanded && <div class="flow-step-output">{output}</div>}
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

// ── Helper: tools toggle ──
function ToolsToggle() {
	const active = chatUseTools.value;
	return (
		<div class="chat-mode-switch">
			<button
				class={`chat-mode-btn${!active ? " selected" : ""}`}
				onClick={() => {
					chatUseTools.value = false;
				}}
			>
				<svg
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
				</svg>
				Chat
			</button>
			<button
				class={`chat-mode-btn${active ? " selected" : ""}`}
				onClick={() => {
					chatUseTools.value = true;
				}}
			>
				<svg
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
				</svg>
				Agent
			</button>
		</div>
	);
}
