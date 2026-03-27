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
		| "flow-failed"
		| "flow-cancelled";
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

export interface AgentVisit {
	agentId: string;
	agentName: string;
	visit: number; // 1-based visit counter for this agent
	output: string;
	duration?: number;
	decision?: string;
	startedAt: number;
	status: "running" | "completed" | "failed";
}

export interface ActiveFlowState {
	executionId: string;
	conversationId: string;
	flowId: string;
	flowName: string;
	initialInput?: string;
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
	// Ordered log of every agent visit — each loop gets its own entry
	visitLog: AgentVisit[];
	// Peer session IDs: agentId → PTY session ID (for terminal attachment)
	peerSessions?: Record<string, string>;
}

// ── localStorage persistence for flow state (survives F5) ──

const FLOW_STORAGE_KEY = "codeck:activeFlow";
const ARCHIVE_STORAGE_KEY = "codeck:archivedFlows";

function loadFlowFromStorage(): ActiveFlowState | null {
	try {
		const raw = localStorage.getItem(FLOW_STORAGE_KEY);
		if (!raw) return null;
		const state = JSON.parse(raw) as ActiveFlowState;
		// Don't restore completed/cancelled/failed flows
		if (state.status !== "running") {
			localStorage.removeItem(FLOW_STORAGE_KEY);
			return null;
		}
		if (state.status === "running" && Date.now() - state.startedAt > 7200000) {
			localStorage.removeItem(FLOW_STORAGE_KEY);
			return null;
		}
		return state;
	} catch {
		localStorage.removeItem(FLOW_STORAGE_KEY);
		return null;
	}
}

function loadArchiveFromStorage(): Record<string, ActiveFlowState> {
	try {
		const raw = localStorage.getItem(ARCHIVE_STORAGE_KEY);
		return raw ? (JSON.parse(raw) as Record<string, ActiveFlowState>) : {};
	} catch {
		return {};
	}
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistFlowState(state: ActiveFlowState | null): void {
	// Null = cleanup — bypass throttle and write immediately
	if (state === null) {
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
		try {
			localStorage.removeItem(FLOW_STORAGE_KEY);
		} catch {}
		return;
	}
	// Throttle writes to max once per second during streaming
	if (persistTimer) return;
	persistTimer = setTimeout(
		() => {
			persistTimer = null;
			try {
				const current = activeFlowExecution.value;
				if (current) {
					localStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify(current));
				} else {
					localStorage.removeItem(FLOW_STORAGE_KEY);
				}
			} catch {
				/* localStorage full or unavailable */
			}
		},
		state === null ? 0 : 1000,
	); // Immediate on clear, throttled on update
}

function persistArchive(archive: Record<string, ActiveFlowState>): void {
	try {
		localStorage.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(archive));
	} catch {
		/* localStorage full or unavailable */
	}
}

export const activeFlowExecution = signal<ActiveFlowState | null>(
	loadFlowFromStorage(),
);
// Archived flows keyed by executionId — preserves final state after completion
export const archivedFlows = signal<Record<string, ActiveFlowState>>(
	loadArchiveFromStorage(),
);
// Incremented on every flow state change to trigger re-renders without remapping chatMessages
export const flowStateVersion = signal(0);
// Which peer agent's terminal is currently open (null = none)
export const openPeerTerminal = signal<string | null>(null);

/**
 * On WS reconnect, check if the locally-stored "running" flow is actually
 * still running on the backend. If the server says it's done (failed/cancelled
 * after a crash), clean up the stale frontend state.
 */
export async function reconcileFlowState(
	apiFetchFn: (url: string, options?: RequestInit) => Promise<Response>,
): Promise<void> {
	const flow = activeFlowExecution.value;
	if (!flow || flow.status !== "running") return;
	try {
		const res = await apiFetchFn(`/api/flows/executions/${flow.executionId}`);
		if (!res.ok) {
			// Execution not found — clean up
			completeFlowExecution(flow.executionId, "failed");
			return;
		}
		const exec = (await res.json()) as { status?: string };
		if (exec.status && exec.status !== "running" && exec.status !== "pending") {
			const status =
				exec.status === "completed" ||
				exec.status === "failed" ||
				exec.status === "cancelled"
					? exec.status
					: "failed";
			completeFlowExecution(flow.executionId, status);
		}
	} catch {
		// Network error — keep current state, will retry on next reconnect
	}
}

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

export function clearChat(apiFetchFn?: ApiFetchFn): void {
	// Cancel any active streaming or flow execution before clearing
	const currentChatId = activeChatId.value;
	const flow = activeFlowExecution.value;
	const cancelBody: Record<string, string> = {};
	if (currentChatId) cancelBody.chatId = currentChatId;
	if (flow && flow.status === "running")
		cancelBody.executionId = flow.executionId;
	if (Object.keys(cancelBody).length > 0) {
		const fetchFn = apiFetchFn || fetch;
		fetchFn("/api/chat/cancel", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(cancelBody),
		}).catch(() => {});
	}
	// Archive active flow before clearing (preserves final state for UI)
	if (flow) {
		completeFlowExecution(flow.executionId, "cancelled");
	}
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
		const data = (await res.json()) as {
			conversations?: ChatConversation[];
		};
		conversations.value = data.conversations || [];
	} catch (err) {
		console.warn("[chat-store] fetchConversations failed:", err);
	}
}

export async function loadConversation(
	id: string,
	apiFetchFn: ApiFetchFn,
): Promise<void> {
	try {
		const res = await apiFetchFn(`/api/chat/conversations/${id}`);
		const data = (await res.json()) as {
			messages?: ChatMessage[];
		};
		if (data.messages) {
			chatMessages.value = data.messages;
			activeConversationId.value = id;
		}
	} catch (err) {
		console.warn("[chat-store] loadConversation failed:", err);
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
	} catch (err) {
		console.warn("[chat-store] renameConversation failed:", err);
	}
}

export async function deleteConversation(
	id: string,
	apiFetchFn: ApiFetchFn,
): Promise<void> {
	try {
		await apiFetchFn(`/api/chat/conversations/${id}`, { method: "DELETE" });
	} catch (err) {
		console.warn("[chat-store] deleteConversation failed:", err);
		return;
	}
	conversations.value = conversations.value.filter((c) => c.id !== id);
	if (activeConversationId.value === id) {
		clearChat(apiFetchFn);
	}
}

// ── Flow integration functions ──

export function startFlowInChat(
	executionId: string,
	conversationId: string,
	flowId: string,
	flowName: string,
	agents: FlowAgent[],
	initialInput?: string,
): void {
	// Idempotent — don't re-initialize if already tracking this execution
	if (activeFlowExecution.value?.executionId === executionId) return;

	// Create initial visit entry for the first agent so UI has immediate feedback
	const firstAgent = agents[0];
	const initialVisit: AgentVisit = {
		agentId: firstAgent?.id || "unknown",
		agentName: firstAgent?.name || "Agent",
		visit: 1,
		output: `Starting ${firstAgent?.name || "agent"}...\n`,
		startedAt: Date.now(),
		status: "running",
	};

	// Clear peer state from previous runs
	clearPeerMessages();
	openPeerTerminal.value = null;

	activeFlowExecution.value = {
		executionId,
		conversationId,
		flowId,
		flowName,
		initialInput,
		agents,
		currentAgentId: firstAgent?.id || null,
		currentAgentIndex: 0,
		status: "running",
		agentOutputs: {},
		agentDurations: {},
		agentDecisions: {},
		agentStartedAt: firstAgent ? { [firstAgent.id]: Date.now() } : {},
		loopCount: 0,
		startedAt: Date.now(),
		completedAt: null,
		visitLog: [initialVisit],
	};
	persistFlowState(activeFlowExecution.value);
	// Only add flow message to chat if triggered from a chat conversation
	// (not from Orchestrator, which passes empty conversationId)
	if (conversationId) {
		chatStreaming.value = true;
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
}

/**
 * Handle flow:execution:update from backend.
 * Creates a new "running" visit entry when the backend transitions to a new agent,
 * bridging the gap between agent:complete and the first agent:output.
 */
export function updateFlowFromExecution(
	executionId: string,
	currentAgentId: string,
	loopCount?: number,
): void {
	const flow = activeFlowExecution.value;
	if (!flow || flow.executionId !== executionId) return;
	// Already tracking this agent — no update needed
	if (flow.currentAgentId === currentAgentId) return;

	const agentDef = flow.agents.find((a) => a.id === currentAgentId);
	const idx = flow.agents.findIndex((a) => a.id === currentAgentId);

	// Create a new "running" visit entry so the UI shows immediate feedback.
	// Skip if appendFlowAgentOutput already created one (race: output arrived first).
	const visitLog = [...flow.visitLog];
	const lastVisit = visitLog[visitLog.length - 1];
	const alreadyTracking =
		lastVisit?.agentId === currentAgentId && lastVisit?.status === "running";
	if (!alreadyTracking) {
		const priorVisits = visitLog.filter(
			(v) => v.agentId === currentAgentId,
		).length;
		visitLog.push({
			agentId: currentAgentId,
			agentName: agentDef?.name || currentAgentId,
			visit: priorVisits + 1,
			output: "",
			startedAt: Date.now(),
			status: "running",
		});
	}

	activeFlowExecution.value = {
		...flow,
		currentAgentId,
		currentAgentIndex: idx >= 0 ? idx : flow.currentAgentIndex,
		loopCount: loopCount ?? flow.loopCount,
		agentStartedAt: { ...flow.agentStartedAt, [currentAgentId]: Date.now() },
		visitLog,
	};
	persistFlowState(activeFlowExecution.value);
	flowStateVersion.value++;
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

	const starts = { ...flow.agentStartedAt };
	if (!starts[agentId]) starts[agentId] = Date.now();

	// Detect loops: agent already completed before and is running again
	let loopCount = flow.loopCount;
	let durations = { ...flow.agentDurations };
	if (flow.currentAgentId !== agentId && durations[agentId] != null) {
		loopCount++;
		const { [agentId]: _, ...withoutAgent } = durations;
		durations = withoutAgent;
		starts[agentId] = Date.now();
	}

	// Visit log: create new entry when agent changes
	const visitLog = [...flow.visitLog];
	const lastVisit = visitLog[visitLog.length - 1];
	if (
		!lastVisit ||
		lastVisit.agentId !== agentId ||
		lastVisit.status !== "running"
	) {
		// New visit — count how many times this agent has been visited
		const priorVisits = visitLog.filter((v) => v.agentId === agentId).length;
		const agentDef = flow.agents.find((a) => a.id === agentId);
		visitLog.push({
			agentId,
			agentName: agentDef?.name || agentId,
			visit: priorVisits + 1,
			output: chunk,
			startedAt: Date.now(),
			status: "running",
		});
	} else {
		// Append to current visit
		visitLog[visitLog.length - 1] = {
			...lastVisit,
			output: lastVisit.output + chunk,
		};
	}

	activeFlowExecution.value = {
		...flow,
		currentAgentId: agentId,
		currentAgentIndex: idx >= 0 ? idx : flow.currentAgentIndex,
		agentOutputs: outputs,
		agentDurations: durations,
		agentStartedAt: starts,
		loopCount,
		visitLog,
	};

	// Persist to localStorage (throttled implicitly by chunked updates)
	persistFlowState(activeFlowExecution.value);

	// Bump version to trigger re-render in components that read flowStateVersion
	flowStateVersion.value++;
}

export function completeFlowAgent(
	executionId: string,
	agentId: string,
	result: {
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

	// Mark the latest visit for this agent as completed
	const visitLog = [...flow.visitLog];
	for (let i = visitLog.length - 1; i >= 0; i--) {
		if (visitLog[i].agentId === agentId && visitLog[i].status === "running") {
			visitLog[i] = {
				...visitLog[i],
				status: "completed",
				duration: durations[agentId],
				decision: result.structuredDecision,
			};
			break;
		}
	}

	activeFlowExecution.value = {
		...flow,
		agentDurations: durations,
		agentDecisions: decisions,
		visitLog,
	};
	persistFlowState(activeFlowExecution.value);
}

export function completeFlowExecution(
	executionId: string,
	status: "completed" | "failed" | "cancelled",
): void {
	const flow = activeFlowExecution.value;
	if (!flow || flow.executionId !== executionId) return;

	const finalFlow: ActiveFlowState = {
		...flow,
		status,
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
	persistArchive(archivedFlows.value);

	// Update the flow message to not streaming
	chatMessages.value = chatMessages.value.map((m) => {
		if (m.flowType === "flow-start" && m.flowExecutionId === executionId) {
			const flowType =
				status === "completed"
					? ("flow-complete" as const)
					: status === "cancelled"
						? ("flow-cancelled" as const)
						: ("flow-failed" as const);
			return {
				...m,
				streaming: false,
				flowType,
				content: status === "cancelled" ? "Flow cancelled" : m.content,
				durationMs: Date.now() - (m.streamStartedAt || Date.now()),
			};
		}
		return m;
	});

	// Only clear streaming if no other message is still streaming
	const stillStreaming = chatMessages.value.some(
		(m) => m.streaming && m.flowExecutionId !== executionId,
	);
	if (!stillStreaming) chatStreaming.value = false;
	activeFlowExecution.value = null;
	openPeerTerminal.value = null;
	persistFlowState(null);
}

/**
 * Register a peer session for an agent — called when flow:peer:session_created arrives.
 */
export function registerPeerSession(
	executionId: string,
	agentId: string,
	sessionId: string,
): void {
	const flow = activeFlowExecution.value;
	if (!flow || flow.executionId !== executionId) return;
	activeFlowExecution.value = {
		...flow,
		peerSessions: { ...(flow.peerSessions || {}), [agentId]: sessionId },
	};
	flowStateVersion.value++;
	persistFlowState(activeFlowExecution.value);
}

/**
 * Toggle which peer terminal is displayed. Same agent → close. Different → switch.
 */
export function togglePeerTerminal(agentId: string | null): void {
	openPeerTerminal.value = openPeerTerminal.value === agentId ? null : agentId;
}

// ── Peer message log (inter-agent communication) ──

export interface PeerMessageEntry {
	id: number;
	timestamp: number;
	from: string;
	to: string;
	type: string;
	payload: string;
	executionId: string;
}

export const peerMessageLog = signal<PeerMessageEntry[]>([]);
let peerMsgCounter = 0;

export function addPeerMessage(
	executionId: string,
	from: string,
	to: string,
	messageType: string,
	payload: string,
): void {
	const flow = activeFlowExecution.value;
	if (!flow || flow.executionId !== executionId) return;
	peerMessageLog.value = [
		...peerMessageLog.value,
		{
			id: ++peerMsgCounter,
			timestamp: Date.now(),
			from,
			to,
			type: messageType,
			payload,
			executionId,
		},
	];
}

export function clearPeerMessages(): void {
	peerMessageLog.value = [];
	peerMsgCounter = 0;
}
