import { signal } from "@preact/signals";

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system" | "flow";
	content: string;
	timestamp: number;
	chatId?: string; // links to streaming response
	streaming?: boolean;
	streamStartedAt?: number; // when streaming began (for elapsed timer)
	durationMs?: number; // total response time (set on complete)
	// Flow-related fields
	flowType?:
		| "flow-start"
		| "agent-active"
		| "agent-complete"
		| "flow-complete"
		| "flow-failed";
	flowAgentId?: string;
	flowAgentName?: string;
	flowExecutionId?: string;
	flowProgress?: { current: number; total: number };
	collapsed?: boolean;
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

// ── Flow execution state ──

export interface FlowAgent {
	id: string;
	name: string;
	role: string;
}

export interface ActiveFlowState {
	executionId: string;
	conversationId: string;
	flowName: string;
	agents: FlowAgent[];
	currentAgentId: string | null;
	currentAgentIndex: number;
	status: "running" | "completed" | "failed" | "cancelled";
	agentOutputs: Record<string, string>;
	agentDurations: Record<string, number>;
	agentDecisions: Record<string, string>;
	agentStartedAt: Record<string, number>;
	loopCount: number;
	startedAt: number;
	completedAt: number | null;
}

export const activeFlowExecution = signal<ActiveFlowState | null>(null);
// Archived flows keyed by executionId — preserves final state after completion
export const archivedFlows = signal<Record<string, ActiveFlowState>>({});
// Incremented on every flow state change to trigger re-renders without remapping chatMessages
export const flowStateVersion = signal(0);

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

// ── Flow integration functions ──

export function startFlowInChat(
	executionId: string,
	conversationId: string,
	flowName: string,
	agents: FlowAgent[],
): void {
	// Idempotent — don't re-initialize if already tracking this execution
	if (activeFlowExecution.value?.executionId === executionId) return;

	activeFlowExecution.value = {
		executionId,
		conversationId,
		flowName,
		agents,
		currentAgentId: null,
		currentAgentIndex: 0,
		status: "running",
		agentOutputs: {},
		agentDurations: {},
		agentDecisions: {},
		agentStartedAt: {},
		loopCount: 0,
		startedAt: Date.now(),
		completedAt: null,
	};
	chatStreaming.value = true;

	// Add flow-start message to chat
	chatMessages.value = [
		...chatMessages.value,
		{
			id: crypto.randomUUID(),
			role: "flow",
			content: "",
			timestamp: Date.now(),
			flowType: "flow-start",
			flowExecutionId: executionId,
			streaming: true,
			streamStartedAt: Date.now(),
		},
	];
}

export function appendFlowAgentOutput(
	executionId: string,
	agentId: string,
	chunk: string,
): void {
	const flow = activeFlowExecution.value;
	if (!flow || flow.executionId !== executionId) return;

	const idx = flow.agents.findIndex((a) => a.id === agentId);
	const outputs = { ...flow.agentOutputs };
	outputs[agentId] = (outputs[agentId] || "") + chunk;

	// Track agent start time (first chunk = agent started)
	const starts = { ...flow.agentStartedAt };
	if (!starts[agentId]) starts[agentId] = Date.now();

	// Detect loops: if this agent already completed before and is running again
	let loopCount = flow.loopCount;
	const durations = { ...flow.agentDurations };
	if (flow.currentAgentId !== agentId && durations[agentId] != null) {
		loopCount++;
		// Reset agent state so UI doesn't show it as both done and running
		delete durations[agentId];
		starts[agentId] = Date.now();
	}

	activeFlowExecution.value = {
		...flow,
		currentAgentId: agentId,
		currentAgentIndex: idx >= 0 ? idx : flow.currentAgentIndex,
		agentOutputs: outputs,
		agentDurations: durations,
		agentStartedAt: starts,
		loopCount,
	};

	// Bump version to trigger re-render in components that read flowStateVersion
	flowStateVersion.value++;
}

export function completeFlowAgent(
	executionId: string,
	agentId: string,
	result: {
		status: string;
		output?: string;
		startedAt?: string;
		completedAt?: string | null;
		structuredDecision?: string;
	},
): void {
	const flow = activeFlowExecution.value;
	if (!flow || flow.executionId !== executionId) return;

	const durations = { ...flow.agentDurations };
	if (result.startedAt && result.completedAt) {
		durations[agentId] =
			new Date(result.completedAt).getTime() -
			new Date(result.startedAt).getTime();
	}

	const decisions = { ...flow.agentDecisions };
	if (result.structuredDecision) {
		decisions[agentId] = result.structuredDecision;
	}

	activeFlowExecution.value = {
		...flow,
		agentDurations: durations,
		agentDecisions: decisions,
	};
}

export function completeFlowExecution(
	executionId: string,
	status: string,
): void {
	const flow = activeFlowExecution.value;
	if (!flow || flow.executionId !== executionId) return;

	const finalStatus =
		status === "completed" || status === "failed" || status === "cancelled"
			? status
			: "completed";

	const finalFlow: ActiveFlowState = {
		...flow,
		status: finalStatus as "completed" | "failed" | "cancelled",
		currentAgentId: null,
		completedAt: Date.now(),
	};

	// Archive the final state so the UI can still render the completed timeline.
	// Cap at 20 entries to prevent unbounded memory growth.
	const MAX_ARCHIVED = 20;
	const updated = { ...archivedFlows.value, [executionId]: finalFlow };
	const keys = Object.keys(updated);
	if (keys.length > MAX_ARCHIVED) {
		// Remove oldest entries (first keys added)
		for (const key of keys.slice(0, keys.length - MAX_ARCHIVED)) {
			delete updated[key];
		}
	}
	archivedFlows.value = updated;

	// Update the flow message to not streaming
	chatMessages.value = chatMessages.value.map((m) => {
		if (m.flowType === "flow-start" && m.flowExecutionId === executionId) {
			const flowType =
				finalStatus === "completed"
					? ("flow-complete" as const)
					: ("flow-failed" as const);
			return {
				...m,
				streaming: false,
				flowType,
				content: finalStatus === "cancelled" ? "Flow cancelled" : m.content,
				durationMs: Date.now() - (m.streamStartedAt || Date.now()),
			};
		}
		return m;
	});

	chatStreaming.value = false;
	activeFlowExecution.value = null;
}
