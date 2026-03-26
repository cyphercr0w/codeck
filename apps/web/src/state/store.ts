import { signal, computed } from "@preact/signals";

// Mobile detection: feature-based (NOT UA sniffing).
// Uses pointer capability + touch support + screen size to identify mobile devices.
// A desktop user with a small browser window is NOT mobile (requires coarse pointer).
function detectMobile(): boolean {
	const hasCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
	const hasTouch = navigator.maxTouchPoints > 0;
	const isSmallScreen = window.matchMedia("(max-width: 1100px)").matches;
	return hasCoarsePointer && hasTouch && isSmallScreen;
}

export const isMobile = signal(detectMobile());

// Mobile keyboard open state — driven by visualViewport height changes.
// When the keyboard opens, the viewport shrinks significantly (>25% smaller than
// the initial height). This is more reliable than focus/blur on the hidden input
// because some browsers don't fire blur when the keyboard dismisses via gesture.
export const mobileKeyboardOpen = signal(false);

if (typeof window !== "undefined") {
	const initialVvHeight = window.visualViewport?.height ?? window.innerHeight;
	const KEYBOARD_THRESHOLD = 0.75; // keyboard is open if viewport < 75% of initial

	const updateKeyboardState = () => {
		if (!isMobile.value) return;
		const currentHeight = window.visualViewport?.height ?? window.innerHeight;
		mobileKeyboardOpen.value =
			currentHeight < initialVvHeight * KEYBOARD_THRESHOLD;
	};

	window.visualViewport?.addEventListener("resize", updateKeyboardState);
}

// Reactively update isMobile when pointer capability or screen size changes
// (e.g., device rotation, toggling mobile emulation in DevTools).
if (typeof window !== "undefined") {
	const pointerMq = window.matchMedia("(pointer: coarse)");
	const screenMq = window.matchMedia("(max-width: 1100px)");
	const updateMobile = () => {
		isMobile.value = detectMobile();
	};
	pointerMq.addEventListener("change", updateMobile);
	screenMq.addEventListener("change", updateMobile);
}

export type View = "loading" | "auth" | "setup" | "preset" | "main";
export type Section =
	| "home"
	| "chat"
	| "filesystem"
	| "claude"
	| "flows"
	| "preview"
	| "agents"
	| "integrations"
	| "config"
	| "settings";
export type AuthMode = "setup" | "login";

export interface LogEntry {
	type: string;
	message: string;
	timestamp: number;
}

export interface TerminalSession {
	id: string;
	type?: "agent" | "shell";
	cwd: string;
	name: string;
	createdAt: number;
	loading?: boolean;
	conversationId?: string;
}

// View state
export const view = signal<View>("loading");
export const activeSection = signal<Section>("home");
export const authMode = signal<AuthMode>("setup");

// Claude
export const claudeAuthenticated = signal(false);

// Account
export const accountEmail = signal<string | null>(null);
export const accountOrg = signal<string | null>(null);
export const accountUuid = signal<string | null>(null);

// Sessions
export const sessions = signal<TerminalSession[]>([]);
export const activeSessionId = signal<string | null>(null);

// Session status indicators: tracks whether each session is actively producing
// output, idle, waiting for user input, or has exited.
export type SessionStatus = "active" | "idle" | "waiting" | "exited";
export const sessionStatus = signal<Record<string, SessionStatus>>({});

export function setSessionStatus(
	sessionId: string,
	status: SessionStatus,
): void {
	const current = sessionStatus.value[sessionId];
	if (current === status) return;
	sessionStatus.value = { ...sessionStatus.value, [sessionId]: status };
}

export function clearSessionStatus(sessionId: string): void {
	const copy = { ...sessionStatus.value };
	delete copy[sessionId];
	sessionStatus.value = copy;
}

// Derived session state
export const activeSession = computed(
	() => sessions.value.find((s) => s.id === activeSessionId.value) ?? null,
);
export const sessionCount = computed(() => sessions.value.length);

// Connection
export const wsConnected = signal(false);
// True while waiting for session restore to complete after a service restart.
export const restoringPending = signal(false);

// Sessions found after restart — held here until user chooses Resume or Discard
export interface PendingSession {
	id: string;
	type: "agent" | "shell";
	cwd: string;
	name: string;
}
export const pendingRestoredSessions = signal<PendingSession[]>([]);

// Logs
export const logs = signal<LogEntry[]>([]);
export const logsExpanded = signal(false);

// Preset
export const presetConfigured = signal(false);

// Workspace
export const workspacePath = signal("/workspace");

// Agent
export const agentName = signal("Claude");

// Ports
export interface PortInfo {
	port: number;
	exposed: boolean;
}
export const activePorts = signal<PortInfo[]>([]);

// Docker experimental mode
export const dockerExperimental = signal(false);

// Files
export const currentFilesPath = signal("");

// ── Centralized setters ──
// All signal mutations should go through these functions to provide a single
// mutation point for logging, validation, or side effects.

export function setView(v: View): void {
	view.value = v;
}
export function setActiveSection(s: Section): void {
	activeSection.value = s;
}
export function setAuthMode(m: AuthMode): void {
	authMode.value = m;
}
export function setActiveSessionId(id: string | null): void {
	activeSessionId.value = id;
}
export function setWsConnected(v: boolean): void {
	wsConnected.value = v;
}
export function setRestoringPending(v: boolean): void {
	restoringPending.value = v;
}
export function setPresetConfigured(v: boolean): void {
	presetConfigured.value = v;
}
export function setActivePorts(ports: PortInfo[]): void {
	activePorts.value = ports;
}
export function setAccountInfo(
	email: string | null,
	org: string | null,
	uuid: string | null,
): void {
	accountEmail.value = email;
	accountOrg.value = org;
	accountUuid.value = uuid;
}

export function updateStateFromServer(data: Record<string, any>): void {
	if (data.claude) {
		claudeAuthenticated.value = data.claude.authenticated;
		if (data.claude.accountInfo) {
			setAccountInfo(
				data.claude.accountInfo.email,
				data.claude.accountInfo.organizationName,
				data.claude.accountInfo.accountUuid,
			);
		}
	}
	if (data.preset) {
		setPresetConfigured(data.preset.configured);
	}
	// Account info bundled in /api/status response — skip separate /api/account call
	if (data.account) {
		setAccountInfo(
			data.account.email,
			data.account.organizationName,
			data.account.accountUuid,
		);
	}
	if (data.workspace) {
		workspacePath.value = data.workspace;
	}
	if (data.agent?.name) {
		agentName.value = data.agent.name;
	}
	if (data.git) {
		// Could expand git state signals if needed
	}
	if (typeof data.dockerExperimental === "boolean") {
		dockerExperimental.value = data.dockerExperimental;
	}
	if (data.pendingRestore === true) {
		restoringPending.value = true;
	}
	// If savedSessions included in status (deferred restore), populate pending list directly
	if (Array.isArray(data.savedSessions) && data.savedSessions.length > 0) {
		pendingRestoredSessions.value = data.savedSessions
			.filter(
				(s: any) => typeof s.cwd === "string" && typeof s.name === "string",
			)
			.map((s: any) => ({
				id: s.id || crypto.randomUUID(),
				type: (s.type as "agent" | "shell") || "agent",
				cwd: s.cwd,
				name: s.name,
			}));
		restoringPending.value = false;
	}
	if (data.sessions) {
		setSessions(
			data.sessions.map((s: any) => ({
				id: s.id,
				type: s.type as "agent" | "shell",
				cwd: s.cwd,
				name: s.name,
				createdAt: s.createdAt || Date.now(),
				conversationId: s.conversationId,
			})),
		);
	}
}

const MAX_LOGS = 1000;

export function addLog(entry: LogEntry): void {
	const newLogs = [...logs.value, entry];
	logs.value = newLogs.length > MAX_LOGS ? newLogs.slice(-MAX_LOGS) : newLogs;
}

export function addLocalLog(type: string, message: string): void {
	addLog({ type, message, timestamp: Date.now() });
}

export function clearLogs(): void {
	logs.value = [];
}

export function addSession(s: TerminalSession): void {
	// Deduplicate: skip if session with same ID already exists
	if (sessions.value.some((existing) => existing.id === s.id)) return;
	sessions.value = [...sessions.value, s];
	// Initialize session status so tab indicators work from the start
	if (!sessionStatus.value[s.id]) {
		setSessionStatus(s.id, "idle");
	}
}

export function setSessions(list: TerminalSession[]): void {
	// Skip update if sessions are identical — avoids spurious re-renders from
	// routine status broadcasts (auth monitor fires every 15s with same data).
	const cur = sessions.value;
	const same =
		cur.length === list.length &&
		cur.every(
			(s, i) =>
				s.id === list[i].id && s.name === list[i].name && s.cwd === list[i].cwd,
		);
	if (same) return;

	sessions.value = list;
	// Initialize status for any new sessions
	const statusUpdates: Record<string, SessionStatus> = {
		...sessionStatus.value,
	};
	let statusChanged = false;
	for (const s of list) {
		if (!statusUpdates[s.id]) {
			statusUpdates[s.id] = "idle";
			statusChanged = true;
		}
	}
	if (statusChanged) sessionStatus.value = statusUpdates;
	// If active session is gone, switch to first available
	if (
		activeSessionId.value &&
		!list.find((s) => s.id === activeSessionId.value)
	) {
		activeSessionId.value = list.length > 0 ? list[0].id : null;
	}
}

export function replaceSession(oldId: string, session: TerminalSession): void {
	sessions.value = sessions.value.map((s) => (s.id === oldId ? session : s));
}

export function renameSession(id: string, name: string): void {
	sessions.value = sessions.value.map((s) =>
		s.id === id ? { ...s, name } : s,
	);
}

export function removeSession(id: string): void {
	sessions.value = sessions.value.filter((s) => s.id !== id);
	// Clean up per-session context data
	if (contextPerSession.value[id]) {
		const copy = { ...contextPerSession.value };
		delete copy[id];
		contextPerSession.value = copy;
	}
	if (activeSessionId.value === id) {
		const remaining = sessions.value;
		activeSessionId.value =
			remaining.length > 0 ? remaining[remaining.length - 1].id : null;
	}
}

// ── Proactive Agents ──

export interface ProactiveAgent {
	id: string;
	name: string;
	status: "active" | "paused" | "error";
	schedule: string;
	objective: string;
	cwd: string;
	model: string;
	timeoutMs: number;
	maxRetries: number;
	consecutiveFailures?: number;
	lastExecutionAt: number | null;
	lastResult: "success" | "failure" | "timeout" | null;
	nextRunAt: number | null;
	totalExecutions: number;
	running: boolean;
	createdAt?: number;
	updatedAt?: number;
}

export const proactiveAgents = signal<ProactiveAgent[]>([]);
export const agentOutputs = signal<Record<string, string>>({});

export function setProactiveAgents(list: ProactiveAgent[]): void {
	proactiveAgents.value = list;
}

export function updateProactiveAgent(agent: ProactiveAgent): void {
	const existing = proactiveAgents.value.find((a) => a.id === agent.id);
	if (existing) {
		proactiveAgents.value = proactiveAgents.value.map((a) =>
			a.id === agent.id ? { ...a, ...agent } : a,
		);
	} else {
		proactiveAgents.value = [...proactiveAgents.value, agent];
	}
}

export function removeProactiveAgent(id: string): void {
	proactiveAgents.value = proactiveAgents.value.filter((a) => a.id !== id);
}

export function setAgentRunning(agentId: string, running: boolean): void {
	proactiveAgents.value = proactiveAgents.value.map((a) =>
		a.id === agentId ? { ...a, running } : a,
	);
}

const MAX_AGENT_OUTPUT = 512 * 1024; // 512KB per agent

export function appendAgentOutput(agentId: string, text: string): void {
	const current = agentOutputs.value[agentId] || "";
	const updated = current + text;
	agentOutputs.value = {
		...agentOutputs.value,
		[agentId]:
			updated.length > MAX_AGENT_OUTPUT
				? updated.slice(-MAX_AGENT_OUTPUT)
				: updated,
	};
}

export function clearAgentOutput(agentId: string): void {
	const copy = { ...agentOutputs.value };
	delete copy[agentId];
	agentOutputs.value = copy;
}

// ── Claude Usage ──

export interface ClaudeUsageData {
	available: boolean;
	fiveHour: { percent: number; resetsAt: string | null } | null;
	sevenDay: { percent: number; resetsAt: string | null } | null;
}

export const claudeUsage = signal<ClaudeUsageData | null>(null);

export function setClaudeUsage(data: ClaudeUsageData): void {
	claudeUsage.value = data;
}

// ── Context Data (from statusline) ──

export interface ContextData {
	contextPercent: number;
	contextTokens: number;
	contextWindow: number;
	model: string;
	updatedAt: number;
}

// Context data stored per session — switching tabs shows that session's data instantly
export const contextPerSession = signal<Record<string, ContextData>>({});
// Computed: context for the active session
export const contextData = computed(() => {
	const id = activeSessionId.value;
	return id ? (contextPerSession.value[id] ?? null) : null;
});

export function setContextData(
	data: ContextData & { sessionId?: string },
): void {
	const sid = data.sessionId;
	if (!sid) return; // Ignore context without explicit sessionId (prevents cross-contamination)
	contextPerSession.value = { ...contextPerSession.value, [sid]: data };
}

// ── Sub-agent tracking (real-time panel) ──

export interface SubagentInfo {
	agentId: string;
	agentType: string;
	sessionId?: string;
	startedAt: number;
	lastLine: string;
	lines: string[];
	duration?: number;
	lastMessage?: string;
}

export const activeSubagents = signal<SubagentInfo[]>([]);

// ── Preview state — persisted in sessionStorage across F5 ──
const _savedPort = sessionStorage.getItem("codeck:previewPort");
export const previewPort = signal<number | null>(
	_savedPort ? parseInt(_savedPort, 10) : null,
);
const _savedUrl = sessionStorage.getItem("codeck:previewUrl");
export const previewUrl = signal<string>(_savedUrl || "localhost:3000");
export const previewSplit = signal<boolean>(_savedPort !== null);

// Auto-persist preview state
previewPort.subscribe((p) => {
	if (p !== null) {
		sessionStorage.setItem("codeck:previewPort", String(p));
	} else {
		sessionStorage.removeItem("codeck:previewPort");
	}
});
previewUrl.subscribe((u) => {
	sessionStorage.setItem("codeck:previewUrl", u);
});

const SUBAGENT_EXPIRE_MS = 10 * 60 * 1000; // 10 min auto-expire
let subagentGcTimer: ReturnType<typeof setInterval> | null = null;

function ensureSubagentGc(): void {
	if (subagentGcTimer) return;
	subagentGcTimer = setInterval(() => {
		const now = Date.now();
		const alive = activeSubagents.value.filter((a) => {
			if (a.duration) return false; // already done, will be cleaned by removeSubagent
			return now - a.startedAt < SUBAGENT_EXPIRE_MS;
		});
		if (
			alive.length !== activeSubagents.value.filter((a) => !a.duration).length
		) {
			activeSubagents.value = alive.concat(
				activeSubagents.value.filter((a) => !!a.duration),
			);
		}
		if (activeSubagents.value.length === 0) {
			clearInterval(subagentGcTimer!);
			subagentGcTimer = null;
		}
	}, 15000);
}

export function addSubagent(data: {
	agentId: string;
	agentType: string;
	sessionId?: string;
	startedAt: number;
	lastMessage?: string;
}): void {
	// Deduplicate — avoid adding the same agent twice (e.g., after a sync + live event)
	if (activeSubagents.value.some((a) => a.agentId === data.agentId)) return;
	activeSubagents.value = [
		...activeSubagents.value,
		{
			...data,
			lastLine: data.lastMessage || "",
			lines: data.lastMessage ? [data.lastMessage] : [],
		},
	];
	ensureSubagentGc();
}

/** Sync active subagents from the server — called on WS reconnect to restore state */
export function syncSubagentsFromServer(
	serverAgents: Array<{
		agentId: string;
		agentType: string;
		sessionId?: string;
		startedAt: number;
		lastLine: string;
	}>,
): void {
	const serverIds = new Set(serverAgents.map((a) => a.agentId));
	// Keep completed agents (with duration) that aren't on the server + add/update running agents from server
	const existing = activeSubagents.value.filter(
		(a) => a.duration || serverIds.has(a.agentId),
	);
	const existingIds = new Set(existing.map((a) => a.agentId));
	const newAgents = serverAgents
		.filter((a) => !existingIds.has(a.agentId))
		.map((a) => ({
			...a,
			lines: a.lastLine ? [a.lastLine] : [],
			lastLine: a.lastLine || "",
		}));
	if (
		newAgents.length > 0 ||
		existing.length !== activeSubagents.value.length
	) {
		activeSubagents.value = [...existing, ...newAgents];
		if (activeSubagents.value.length > 0) ensureSubagentGc();
	}
}

const MAX_SUBAGENT_LINES = 200;

export function updateSubagentOutput(agentId: string, text: string): void {
	activeSubagents.value = activeSubagents.value.map((a) =>
		a.agentId === agentId
			? {
					...a,
					lastLine: text,
					lines: [...a.lines, text].slice(-MAX_SUBAGENT_LINES),
				}
			: a,
	);
}

export function removeSubagent(
	agentId: string,
	duration?: number,
	lastMessage?: string,
): void {
	// Keep completed agents briefly so UI can show the result
	activeSubagents.value = activeSubagents.value.map((a) =>
		a.agentId === agentId
			? { ...a, duration, lastMessage: lastMessage || a.lastLine }
			: a,
	);
	// Remove after 5s
	setTimeout(() => {
		activeSubagents.value = activeSubagents.value.filter(
			(a) => a.agentId !== agentId,
		);
	}, 5000);
}

// ── Global Toast System ──

export interface Toast {
	id: number;
	type: "success" | "error" | "info";
	message: string;
}

export const toasts = signal<Toast[]>([]);
let toastIdCounter = 0;

export function showToast(
	message: string,
	type: Toast["type"] = "success",
	duration = 4000,
): void {
	const id = ++toastIdCounter;
	toasts.value = [...toasts.value, { id, type, message }];
	if (duration > 0) {
		setTimeout(() => dismissToast(id), duration);
	}
}

export function dismissToast(id: number): void {
	toasts.value = toasts.value.filter((t) => t.id !== id);
}

// ── Recent Conversations Cache ──

export interface RecentConversation {
	id: string;
	title: string;
	cwd: string;
	mtime: number;
}

export const recentConversations = signal<RecentConversation[]>([]);
let recentConvosFetchedAt = 0;
const RECENT_CONVOS_TTL = 5 * 60 * 1000; // 5 min cache

export async function fetchRecentConversations(
	fetchFn: (url: string) => Promise<Response>,
	force = false,
): Promise<void> {
	const now = Date.now();
	if (
		!force &&
		recentConvosFetchedAt > 0 &&
		now - recentConvosFetchedAt < RECENT_CONVOS_TTL
	) {
		return; // cache still valid
	}
	try {
		const res = await fetchFn("/api/console/recent-conversations");
		const data = await res.json();
		if (data.conversations) {
			recentConversations.value = data.conversations;
			recentConvosFetchedAt = now;
		}
	} catch {
		/* non-fatal */
	}
}

// ── Usage Polling ──

let usagePollTimer: ReturnType<typeof setInterval> | null = null;

export function startUsagePolling(
	fetchFn: (url: string, opts?: RequestInit) => Promise<Response>,
): void {
	if (usagePollTimer) return; // already polling

	async function poll() {
		try {
			const res = await fetchFn("/api/dashboard");
			const data = await res.json();
			if (data.claude) {
				setClaudeUsage(data.claude);
			}
		} catch {
			/* ignore */
		}
	}

	poll(); // immediate first fetch
	usagePollTimer = setInterval(poll, 300_000); // 5 min — match backend cache TTL
}

export function stopUsagePolling(): void {
	if (usagePollTimer) {
		clearInterval(usagePollTimer);
		usagePollTimer = null;
	}
}
