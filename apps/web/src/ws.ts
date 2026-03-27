import {
	setWsConnected,
	updateStateFromServer,
	addLog,
	sessions,
	setActivePorts,
	setRestoringPending,
	type LogEntry,
	removeSession,
	updateProactiveAgent,
	appendAgentOutput,
	setAgentRunning,
	claudeAuthenticated,
	setContextData,
	addSubagent,
	updateSubagentOutput,
	removeSubagent,
	syncSubagentsFromServer,
	fetchRecentFolders,
	pendingRestoredSessions,
	previewPort,
	previewUrl,
	previewMode,
	mobilePreviewOpen,
	isMobile,
	showToast,
	addFileChange,
	clearChanges,
	activeSessionId,
	type FileDiffData,
} from "./state/store";
import {
	appendToAssistant,
	completeAssistant,
	startFlowInChat,
	appendFlowAgentOutput,
	completeFlowAgent,
	completeFlowExecution,
	updateFlowFromExecution,
	reconcileFlowState,
	registerPeerSession,
	addPeerMessage,
	markAgentActivated,
	updatePeerSummary,
} from "./state/chat-store";
import { apiFetch, getAuthToken } from "./api";

// Known WebSocket message types — reject anything not in this set
const KNOWN_MSG_TYPES = new Set([
	"heartbeat",
	"status",
	"log",
	"logs",
	"ports",
	"sessions:restored",
	"console:error",
	"console:output",
	"console:exit",
	"console:freeze",
	"console:context_loaded",
	"context",
	"agent:update",
	"agent:output",
	"agent:execution:start",
	"agent:execution:complete",
	"auth:expiring",
	"auth:expired",
	"subagent:start",
	"subagent:output",
	"subagent:stop",
	"preview:navigate",
	"preview:frame",
	"preview:error",
	"session:conversationId",
	"chat:response:chunk",
	"chat:response:complete",
	"chat:response:error",
	"chat:flow:started",
	"flow:execution:update",
	"flow:agent:output",
	"flow:agent:complete",
	"flow:execution:complete",
	"flow:peer:session_created",
	"flow:peer:message",
	"flow:peer:summary",
	"changes:file",
	"changes:window",
]);

/** Runtime validation for incoming WebSocket messages */
function isValidWsMessage(
	msg: unknown,
): msg is { type: string; [k: string]: unknown } {
	return (
		typeof msg === "object" &&
		msg !== null &&
		typeof (msg as any).type === "string" &&
		KNOWN_MSG_TYPES.has((msg as any).type)
	);
}

function isLogEntry(data: unknown): data is LogEntry {
	return (
		typeof data === "object" &&
		data !== null &&
		typeof (data as any).type === "string" &&
		typeof (data as any).message === "string" &&
		typeof (data as any).timestamp === "number"
	);
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let staleCheckTimer: ReturnType<typeof setInterval> | null = null;
let lastMessageAt = 0;
let reconnectBackoff = 500; // Exponential backoff: 0.5s → 1s → 2s → ... → 15s cap
let reconnectAttempts = 0;
let isFirstConnection = true; // Skip health check on first attempt (page just loaded)

// True only on the first status message after a WS reconnect.
// Prevents onSessionReattached from firing on every status broadcast
// (auth monitor, session events, etc.) — it should only fire after a real reconnect.
let pendingReattach = false;

// Track which sessions have been attached on the current WS connection
// to prevent duplicate console:attach messages on reconnect.
const attachedSessions = new Set<string>();

// Buffer the last resize per session sent while disconnected.
// On reconnect, all buffered resizes are flushed so every terminal
// gets its correct dimensions — not just the last one that fired.
const pendingResizes = new Map<string, object>();

// Buffer console:input messages sent while disconnected or pre-attach so
// keystrokes aren't silently dropped during brief reconnects.
// Keyed by sessionId so inputs can be flushed per-session inside attachSession
// (AFTER console:attach is sent) rather than in onopen (BEFORE attach).
const MAX_PENDING_INPUTS = 200;
const pendingInputs = new Map<string, object[]>();

// Called after each session is re-attached on reconnect, so the
// terminal layer can resync PTY dimensions for that session.
let onSessionReattached: ((sessionId: string) => void) | null = null;
export function setOnSessionReattached(
	handler: (sessionId: string) => void,
): void {
	onSessionReattached = handler;
}

// Called before sessions:restored adds new sessions, so the terminal layer
// can destroy stale terminals from a previous container lifecycle.
let onBeforeSessionsRestored: (() => void) | null = null;
export function setOnBeforeSessionsRestored(handler: () => void): void {
	onBeforeSessionsRestored = handler;
}

// Called when the server broadcasts context injection stats for a session
export interface ContextLoadedData {
	charsInjected: number;
	projectName: string;
	sources: string[];
}
let onContextLoaded:
	| ((sessionId: string, data: ContextLoadedData) => void)
	| null = null;
export function setOnContextLoaded(
	handler: (sessionId: string, data: ContextLoadedData) => void,
): void {
	onContextLoaded = handler;
}

type OutputHandler = (sessionId: string, data: string) => void;
type ExitHandler = (sessionId: string) => void;

let onOutput: OutputHandler | null = null;
let onExit: ExitHandler | null = null;

// Preview frame callback (CDP screencast)
type PreviewFrameHandler = (
	data: string,
	metadata: Record<string, unknown>,
) => void;
let onPreviewFrame: PreviewFrameHandler | null = null;

export function setPreviewFrameHandler(
	handler: PreviewFrameHandler | null,
): void {
	onPreviewFrame = handler;
}

type PreviewErrorHandler = (error: string, url: string) => void;
let onPreviewError: PreviewErrorHandler | null = null;

export function setPreviewErrorHandler(
	handler: PreviewErrorHandler | null,
): void {
	onPreviewError = handler;
}

export function setTerminalHandlers(
	output: OutputHandler,
	exit: ExitHandler,
): void {
	onOutput = output;
	onExit = exit;
}

export function wsSend(msg: object): void {
	const msgType = (msg as any).type;
	if (ws && ws.readyState === WebSocket.OPEN) {
		// Buffer console:input if this session hasn't been re-attached yet.
		// Covers the pendingReattach window and the status→rAF gap (~16ms).
		if (msgType === "console:input") {
			const sid = (msg as any).sessionId;
			if (typeof sid === "string" && !attachedSessions.has(sid)) {
				const arr = pendingInputs.get(sid) ?? [];
				if (!pendingInputs.has(sid)) pendingInputs.set(sid, arr);
				if (arr.length < MAX_PENDING_INPUTS) arr.push(msg);
				return;
			}
		}
		ws.send(JSON.stringify(msg));
	} else if (msgType === "console:resize") {
		// Buffer resize per session — replaces any previous buffered resize
		const sessionId = (msg as any).sessionId;
		if (typeof sessionId === "string") {
			pendingResizes.set(sessionId, msg);
		}
	} else if (msgType === "console:input") {
		// Buffer input so keystrokes typed during a brief disconnect aren't lost
		const sid = (msg as any).sessionId;
		if (typeof sid === "string") {
			const arr = pendingInputs.get(sid) ?? [];
			if (arr.length < MAX_PENDING_INPUTS) {
				if (!pendingInputs.has(sid)) pendingInputs.set(sid, arr);
				arr.push(msg);
			}
		}
	}
}

// Pending attach queue — if WS is not open when attachSession is called,
// the attach message is queued and sent once the connection opens.
const pendingAttaches = new Set<string>();

/** Send console:attach only once per session per WS connection.
 *  After attaching, flushes any inputs buffered while the WS was down. */
export function attachSession(sessionId: string): void {
	if (attachedSessions.has(sessionId)) return;
	attachedSessions.add(sessionId);
	if (ws && ws.readyState === WebSocket.OPEN) {
		wsSend({ type: "console:attach", sessionId });
	} else {
		// WS not ready — queue the attach for when it connects
		pendingAttaches.add(sessionId);
	}

	// Flush pending inputs immediately after attach — the server processes
	// console:attach synchronously and registers the client before reading
	// the next frame, so no artificial delay is needed.
	const pending = pendingInputs.get(sessionId);
	if (pending && pending.length > 0) {
		pendingInputs.delete(sessionId);
		for (const msg of pending) wsSend(msg);
	}
}

function openWs(wsUrl: string, protocols?: string[]): void {
	ws = protocols ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl);

	ws.onopen = () => {
		setWsConnected(true);
		lastMessageAt = Date.now();
		reconnectBackoff = 500;
		reconnectAttempts = 0;
		attachedSessions.clear();
		pendingReattach = true;
		addLog({
			type: "info",
			message: "Connected to server",
			timestamp: Date.now(),
		});

		// Flush all buffered resize messages
		for (const msg of pendingResizes.values()) {
			ws!.send(JSON.stringify(msg));
		}
		pendingResizes.clear();

		// Flush pending attach messages (sessions created while WS was down)
		for (const sid of pendingAttaches) {
			ws!.send(JSON.stringify({ type: "console:attach", sessionId: sid }));
		}
		pendingAttaches.clear();
		// pendingInputs are flushed per-session inside attachSession()

		// Stale connection detector
		if (staleCheckTimer) clearInterval(staleCheckTimer);
		staleCheckTimer = setInterval(() => {
			if (
				ws &&
				ws.readyState === WebSocket.OPEN &&
				Date.now() - lastMessageAt > 60000
			) {
				console.warn("[WS] Connection stale (no data in 60s), reconnecting");
				ws.close();
			}
		}, 10000);
	};

	ws.onmessage = (e) => {
		lastMessageAt = Date.now();
		try {
			const raw = JSON.parse(e.data);
			if (!isValidWsMessage(raw)) {
				console.warn("[WS] Unknown or malformed message type:", raw?.type);
				return;
			}
			const msg = raw as { type: string; data?: any; sessionId?: string };
			if (msg.type === "heartbeat") return;
			if (msg.type === "status") {
				if (typeof msg.data !== "object" || msg.data === null) return;
				updateStateFromServer(msg.data);
				// Only reattach terminals on the first status after a real WS reconnect
				if (pendingReattach) {
					pendingReattach = false;
					sessions.value.forEach((s) => {
						onSessionReattached?.(s.id);
					});
					// Restore active subagents from server (may have been lost during disconnect)
					apiFetch("/api/console/subagents")
						.then((r) => r.json())
						.then((data) => {
							if (data.agents) syncSubagentsFromServer(data.agents);
						})
						.catch(() => {
							/* non-fatal */
						});
					// Pre-fetch recent folders so New Tab opens instantly (force — server state may have changed)
					fetchRecentFolders(apiFetch, true);
					// Reconcile stale flow state — if localStorage says "running" but
					// the backend says otherwise (crash, restart), clean it up.
					reconcileFlowState(apiFetch);
				}
				if (!msg.data.pendingRestore) {
					setRestoringPending(false);
				}
			} else if (msg.type === "log") {
				if (!isLogEntry(msg.data)) return;
				addLog(msg.data);
			} else if (msg.type === "logs") {
				if (!Array.isArray(msg.data)) return;
				msg.data.filter(isLogEntry).forEach((entry) => addLog(entry));
			} else if (msg.type === "ports") {
				if (!Array.isArray(msg.data)) return;
				setActivePorts(msg.data);
			} else if (msg.type === "sessions:restored") {
				if (!Array.isArray(msg.data)) return;
				const restored = msg.data.filter(
					(s: any) =>
						typeof s.id === "string" &&
						typeof s.cwd === "string" &&
						typeof s.name === "string" &&
						s.type !== "peer", // Peer sessions are managed by PeerExecutionViewer, not ClaudeSection
				);
				// Don't auto-mount — let user choose Resume or Discard
				if (restored.length > 0) {
					onBeforeSessionsRestored?.();
					const staleIds = sessions.value.map((s) => s.id);
					for (const id of staleIds) removeSession(id);
					pendingRestoredSessions.value = restored.map((s: any) => ({
						id: s.id,
						type: (s.type as "agent" | "shell") || "agent",
						cwd: s.cwd,
						name: s.name,
					}));
				}
				setRestoringPending(false);
			} else if (msg.type === "console:error") {
				if (typeof msg.sessionId === "string") {
					removeSession(msg.sessionId);
				}
			} else if (msg.type === "console:output") {
				if (typeof msg.sessionId === "string" && typeof msg.data === "string") {
					onOutput?.(msg.sessionId, msg.data);
				}
			} else if (msg.type === "console:context_loaded") {
				if (
					typeof msg.sessionId === "string" &&
					typeof msg.data === "object" &&
					msg.data !== null
				) {
					onContextLoaded?.(msg.sessionId, msg.data as ContextLoadedData);
				}
			} else if (msg.type === "console:freeze") {
				// Server detected PTY freeze — log diagnostic info
				if (typeof msg.sessionId === "string") {
					const raw = msg as Record<string, unknown>;
					const dur =
						typeof raw.durationMs === "number"
							? Math.round(raw.durationMs / 1000)
							: "?";
					const alive = raw.ptyAlive ? "alive" : "DEAD";
					const lag =
						typeof raw.eventLoopLagMs === "number" ? raw.eventLoopLagMs : "?";
					addLog({
						type: "warn",
						message: `Terminal freeze: ${dur}s (PTY: ${alive}, event loop lag: ${lag}ms)`,
						timestamp: Date.now(),
					});
				}
			} else if (msg.type === "console:exit") {
				if (typeof msg.sessionId === "string") {
					onExit?.(msg.sessionId);
				}
			} else if (msg.type === "agent:update") {
				if (
					typeof msg.data === "object" &&
					msg.data !== null &&
					typeof msg.data.id === "string"
				) {
					updateProactiveAgent(msg.data);
				}
			} else if (msg.type === "agent:output") {
				if (
					typeof msg.data?.agentId === "string" &&
					typeof msg.data?.text === "string"
				) {
					appendAgentOutput(msg.data.agentId, msg.data.text);
				}
			} else if (msg.type === "agent:execution:start") {
				if (typeof msg.data?.agentId === "string") {
					setAgentRunning(msg.data.agentId, true);
				}
			} else if (msg.type === "agent:execution:complete") {
				if (typeof msg.data?.agentId === "string") {
					setAgentRunning(msg.data.agentId, false);
				}
			} else if (msg.type === "auth:expiring") {
				const minutes =
					typeof msg.data?.minutesLeft === "number"
						? msg.data.minutesLeft
						: "?";
				addLog({
					type: "warn",
					message: `Claude session expires in ${minutes} minutes. Please re-login to avoid interruptions.`,
					timestamp: Date.now(),
				});
			} else if (msg.type === "auth:expired") {
				claudeAuthenticated.value = false;
			} else if (msg.type === "context") {
				if (typeof msg.data === "object" && msg.data !== null) {
					setContextData(msg.data as any);
				}
			} else if (msg.type === "subagent:start" && msg.data) {
				addSubagent(msg.data as any);
			} else if (msg.type === "subagent:output" && msg.data) {
				updateSubagentOutput((msg.data as any).agentId, (msg.data as any).text);
			} else if (msg.type === "subagent:stop" && msg.data) {
				removeSubagent(
					(msg.data as any).agentId,
					(msg.data as any).duration,
					(msg.data as any).lastMessage,
				);
			} else if (msg.type === "preview:navigate" && msg.data) {
				// Agent requested a preview — open it
				const { port, url } = msg.data as { port?: number; url?: string };
				if (port) {
					previewPort.value = port;
					previewUrl.value = url || `localhost:${port}`;
					if (isMobile.value) {
						mobilePreviewOpen.value = false; // show indicator, user taps to expand
					} else {
						previewMode.value = "split";
					}
					showToast(`Preview opened on port ${port}`, "info", 3000);
				}
			} else if (msg.type === "preview:frame" && msg.data) {
				onPreviewFrame?.(
					msg.data as string,
					((raw as any).metadata as Record<string, unknown>) || {},
				);
			} else if (msg.type === "preview:error") {
				onPreviewError?.(
					((raw as any).error as string) || "Unknown error",
					((raw as any).url as string) || "",
				);
			} else if (msg.type === "session:conversationId") {
				const sid = msg.sessionId as string;
				const convId = (raw as any).conversationId as string;
				if (sid && convId) {
					const current = sessions.value;
					const idx = current.findIndex((s) => s.id === sid);
					if (idx >= 0 && !current[idx].conversationId) {
						const updated = [...current];
						updated[idx] = { ...updated[idx], conversationId: convId };
						sessions.value = updated;
					}
				}
			} else if (msg.type === "chat:response:chunk" && msg.data) {
				const d = msg.data as Record<string, unknown>;
				if (typeof d.chatId === "string" && typeof d.chunk === "string") {
					appendToAssistant(d.chatId, d.chunk);
				}
			} else if (msg.type === "chat:response:error" && msg.data) {
				// Error during streaming — complete the assistant message with error
				const d = msg.data as Record<string, unknown>;
				if (typeof d.chatId === "string") {
					completeAssistant(
						d.chatId,
						1,
						typeof d.error === "string" ? d.error : "Unknown error",
					);
				}
			} else if (msg.type === "chat:response:complete" && msg.data) {
				const d = msg.data as Record<string, unknown>;
				if (typeof d.chatId === "string") {
					completeAssistant(
						d.chatId,
						typeof d.exitCode === "number" ? d.exitCode : 0,
						typeof d.error === "string" ? d.error : undefined,
					);
				}
			} else if (msg.type === "chat:flow:started" && msg.data) {
				const d = msg.data as Record<string, unknown>;
				if (
					typeof d.executionId === "string" &&
					typeof d.conversationId === "string" &&
					typeof d.flowName === "string" &&
					Array.isArray(d.agents)
				) {
					const flowId = typeof d.flowId === "string" ? d.flowId : "";
					// Validate each agent element has the required fields
					const validAgents = (d.agents as unknown[]).filter(
						(a): a is { id: string; name: string; role: string } => {
							if (typeof a !== "object" || a === null) return false;
							const obj = a as Record<string, unknown>;
							return (
								typeof obj.id === "string" &&
								typeof obj.name === "string" &&
								typeof obj.role === "string"
							);
						},
					);
					if (validAgents.length > 0) {
						startFlowInChat(
							d.executionId,
							d.conversationId,
							flowId,
							d.flowName,
							validAgents,
							typeof d.initialInput === "string" ? d.initialInput : undefined,
						);
					}
				}
			} else if (msg.type === "flow:agent:output" && msg.data) {
				const d = msg.data as Record<string, unknown>;
				if (
					typeof d.executionId === "string" &&
					typeof d.agentId === "string" &&
					typeof d.chunk === "string"
				) {
					appendFlowAgentOutput(d.executionId, d.agentId, d.chunk);
				}
			} else if (msg.type === "flow:agent:complete" && msg.data) {
				const d = msg.data as Record<string, unknown>;
				if (
					typeof d.executionId === "string" &&
					typeof d.agentId === "string" &&
					typeof d.result === "object" &&
					d.result !== null
				) {
					const r = d.result as Record<string, unknown>;
					completeFlowAgent(d.executionId, d.agentId, {
						output: typeof r.output === "string" ? r.output : undefined,
						startedAt:
							typeof r.startedAt === "string" ? r.startedAt : undefined,
						completedAt:
							typeof r.completedAt === "string" ? r.completedAt : null,
						structuredDecision:
							typeof r.structuredDecision === "string"
								? r.structuredDecision
								: undefined,
					});
				}
			} else if (msg.type === "flow:execution:complete" && msg.data) {
				const d = msg.data as Record<string, unknown>;
				if (typeof d.id === "string") {
					const s = typeof d.status === "string" ? d.status : "completed";
					const validStatus =
						s === "completed" || s === "failed" || s === "cancelled"
							? s
							: "completed";
					completeFlowExecution(d.id, validStatus);
				}
			} else if (msg.type === "changes:file" && msg.data) {
				const sessionId = msg.sessionId;
				if (typeof sessionId === "string" && typeof msg.data === "object") {
					addFileChange(sessionId, msg.data as FileDiffData);
				}
			} else if (msg.type === "changes:window") {
				// New diff window — clear current changes only for the active session
				const sid = msg.sessionId;
				if (typeof sid === "string" && sid === activeSessionId.value) {
					clearChanges();
				}
			} else if (msg.type === "flow:peer:session_created" && msg.data) {
				const d = msg.data as Record<string, unknown>;
				if (
					typeof d.executionId === "string" &&
					typeof d.agentId === "string" &&
					typeof d.sessionId === "string"
				) {
					registerPeerSession(d.executionId, d.agentId, d.sessionId);
					// Eagerly attach the session so output starts flowing immediately.
					// The terminal DOM element may not exist yet, but attachSession
					// ensures console:output data is buffered by writeToTerminal once
					// the xterm instance is created later.
					attachSession(d.sessionId);
				}
			} else if (msg.type === "flow:peer:message" && msg.data) {
				const d = msg.data as Record<string, unknown>;
				if (
					typeof d.executionId === "string" &&
					typeof d.from === "string" &&
					typeof d.to === "string"
				) {
					addPeerMessage(
						d.executionId,
						d.from,
						d.to,
						typeof d.fromAgentId === "string" ? d.fromAgentId : d.from,
						typeof d.toAgentId === "string" ? d.toAgentId : d.to,
						typeof d.messageType === "string" ? d.messageType : "message",
						typeof d.payload === "string" ? d.payload : "",
					);
					// Mark target agent as activated (for status derivation)
					if (typeof d.toAgentId === "string") {
						markAgentActivated(d.executionId, d.toAgentId);
					}
				}
			} else if (msg.type === "flow:peer:summary" && msg.data) {
				const d = msg.data as Record<string, unknown>;
				if (
					typeof d.executionId === "string" &&
					typeof d.agentId === "string" &&
					typeof d.summary === "string"
				) {
					updatePeerSummary(d.executionId, d.agentId, d.summary);
				}
			} else if (msg.type === "flow:execution:update" && msg.data) {
				// Sync frontend state when backend transitions between agents.
				// Without this, the frontend has a gap between agent:complete and the
				// first agent:output where no "running" entry exists in the visitLog.
				const d = msg.data as Record<string, unknown>;
				if (typeof d.id === "string" && typeof d.currentAgentId === "string") {
					updateFlowFromExecution(
						d.id,
						d.currentAgentId,
						typeof d.loopCount === "number" ? d.loopCount : undefined,
					);
				}
			}
		} catch (err) {
			console.warn("[WS] Failed to parse message:", err);
		}
	};

	ws.onclose = () => {
		setWsConnected(false);
		ws = null;
		if (staleCheckTimer) {
			clearInterval(staleCheckTimer);
			staleCheckTimer = null;
		}

		const delay =
			reconnectAttempts === 0
				? 50
				: reconnectBackoff * (0.5 + Math.random() * 0.5);
		reconnectAttempts++;
		reconnectTimer = setTimeout(connectWebSocket, delay);
		reconnectBackoff = Math.min(reconnectBackoff * 2, 15000);
	};

	ws.onerror = () => ws?.close();
}

export async function connectWebSocket(): Promise<void> {
	// Clear any pending reconnect timer to prevent overlapping attempts
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	if (ws && ws.readyState !== WebSocket.CLOSED) return;

	// Pre-flight: check if runtime is ready before attempting WS upgrade.
	// Skip on first connection (page just loaded — server is obviously up).
	if (!isFirstConnection) {
		try {
			const healthRes = await fetch("/api/runtime/health", {
				cache: "no-store",
			});
			const health = await healthRes.json();
			if (!health.ready) {
				const delay = reconnectBackoff * (0.5 + Math.random() * 0.5);
				reconnectTimer = setTimeout(connectWebSocket, delay);
				reconnectBackoff = Math.min(reconnectBackoff * 2, 15000);
				return;
			}
		} catch {
			const delay = reconnectBackoff * (0.5 + Math.random() * 0.5);
			reconnectTimer = setTimeout(connectWebSocket, delay);
			reconnectBackoff = Math.min(reconnectBackoff * 2, 15000);
			return;
		}
	}
	isFirstConnection = false;

	const token = getAuthToken();
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";

	// Send auth token via WebSocket subprotocol header instead of URL query param.
	// This keeps the token out of server logs, browser history, and proxy access logs.
	// Format: "auth.<base64url-encoded-token>" as a subprotocol name.
	const wsUrl = `${protocol}//${location.host}`;
	if (!token) {
		openWs(wsUrl);
		return;
	}
	const encodedToken = btoa(token)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	openWs(wsUrl, [`auth.${encodedToken}`]);
}

export function disconnectWebSocket(): void {
	if (reconnectTimer) clearTimeout(reconnectTimer);
	reconnectTimer = null;
	if (staleCheckTimer) {
		clearInterval(staleCheckTimer);
		staleCheckTimer = null;
	}
	ws?.close();
	ws = null;
}

// Clean up timers before page unload to prevent ghost reconnection loops
if (typeof window !== "undefined") {
	window.addEventListener("beforeunload", () => disconnectWebSocket());
}
