import { useState, useEffect, useRef } from "preact/hooks";
import { apiFetch } from "../api";
import { showToast } from "../state/store";
import {
	activeFlowExecution,
	archivedFlows,
	startFlowInChat,
	reconcileFlowState,
} from "../state/chat-store";
import { FlowCanvas } from "./FlowCanvas";
import { IconPlus, IconPlay, IconEdit } from "./Icons";
import { ExecutionRow } from "./flows/ExecutionRow";
import { ActiveFlowBanner } from "./flows/ActiveFlowBanner";
import { FlowCard } from "./flows/FlowCard";
import {
	walkAgents,
	type SystemAgent,
	type FlowDef,
	type FlowExecution,
} from "./flows/flow-types";
import PeerExecutionViewer from "./flows/PeerExecutionViewer";

// walkAgents, types, ALL_TOOLS imported from ./flows/flow-types

// ── Elapsed Timer ──

/** Format seconds into human-readable duration (e.g. 45s, 2m 30s, 1h 5m) */
function formatDuration(seconds: number): string {
	const s = Math.round(seconds);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
	const h = Math.floor(m / 60);
	const remM = m % 60;
	return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

function FlowTimer({ startedAt }: { startedAt?: number }) {
	const [elapsed, setElapsed] = useState(() =>
		startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0,
	);
	useEffect(() => {
		if (!startedAt) return;
		setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
		const iv = setInterval(
			() =>
				setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))),
			1000,
		);
		return () => clearInterval(iv);
	}, [startedAt]);
	if (!startedAt) return null;
	const m = Math.floor(elapsed / 60);
	const s = elapsed % 60;
	return <span class="flow-timer">{m > 0 ? `${m}m ${s}s` : `${s}s`}</span>;
}

// ══════════════════════════════════════════
// ══ MAIN COMPONENT
// ══════════════════════════════════════════

// Module-level cache — persists across tab switches (component unmount/remount)
let cachedFlows: FlowDef[] = [];
let cachedExecutions: FlowExecution[] = [];
let cachedSystemAgents: SystemAgent[] = [];
let cacheLoaded = false;

export function FlowsSection() {
	const [flows, setFlows] = useState<FlowDef[]>(cachedFlows);
	const [executions, setExecutions] =
		useState<FlowExecution[]>(cachedExecutions);
	const [systemAgents, setSystemAgents] =
		useState<SystemAgent[]>(cachedSystemAgents);
	const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
	const [selectedExecId, setSelectedExecId] = useState<string | null>(null);
	const [editingFlow, setEditingFlow] = useState<FlowDef | null>(null);
	// editingAgentId removed — canvas manages selection internally
	const [runInput, setRunInput] = useState("");
	const [running, setRunning] = useState(false);
	const [view, setView] = useState<"list" | "edit" | "run">("list");

	const liveFlow = activeFlowExecution.value;
	const isAnyFlowRunning = liveFlow?.status === "running";
	const loadingExecutions = useRef(false);

	useEffect(() => {
		// Always refresh in background, but show cached data instantly
		loadFlows();
		loadExecutions();
		// Reconcile stale flow state — if localStorage says "running" but the
		// backend says otherwise (crash, restart), clean it up immediately.
		reconcileFlowState(apiFetch);
		if (!cacheLoaded) {
			loadSystemAgents();
			cacheLoaded = true;
		}
	}, []);

	// Auto-navigate to running flow when entering Orchestrator
	useEffect(() => {
		if (view !== "list") return;
		// If we have a live flow, go to its detail view
		if (isAnyFlowRunning && liveFlow) {
			const f =
				flows.find((fl) => fl.id === liveFlow.flowId) ??
				flows.find((fl) => fl.name === liveFlow.flowName);
			if (f) {
				setSelectedFlowId(f.id);
				setView("run");
				return;
			}
		}
		// If server reports a running execution, go to it
		const serverRunning = executions.find((e) => e.status === "running");
		if (serverRunning) {
			const f = flows.find((fl) => fl.id === serverRunning.flowId);
			if (f) {
				setSelectedFlowId(f.id);
				setView("run");
			}
		}
	}, [flows.length, executions.length, isAnyFlowRunning]);
	useEffect(() => {
		if (!isAnyFlowRunning) {
			loadExecutions();
			return;
		}
		const iv = setInterval(() => {
			if (!loadingExecutions.current) loadExecutions();
		}, 5000);
		return () => clearInterval(iv);
	}, [isAnyFlowRunning]);

	async function loadFlows() {
		try {
			const r = await apiFetch("/api/flows");
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const d = await r.json();
			const list = d.flows || [];
			cachedFlows = list;
			setFlows(list);
		} catch {
			/* use cache on failure */
		}
	}
	async function loadExecutions() {
		if (loadingExecutions.current) return;
		loadingExecutions.current = true;
		try {
			const r = await apiFetch("/api/flows/executions/list");
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const d = await r.json();
			const list = d.executions || [];
			cachedExecutions = list;
			setExecutions(list);
		} catch {
			/* use cache on failure */
		} finally {
			loadingExecutions.current = false;
		}
	}
	async function loadSystemAgents() {
		try {
			const r = await apiFetch("/api/flows/available-agents");
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const d = await r.json();
			cachedSystemAgents = d.agents || [];
			setSystemAgents(cachedSystemAgents);
		} catch {
			/* use cache */
		}
	}
	async function deleteFlow(id: string) {
		try {
			await apiFetch(`/api/flows/${id}`, { method: "DELETE" });
			setFlows((p) => p.filter((f) => f.id !== id));
			showToast("Flow deleted", "info");
		} catch {
			showToast("Failed to delete flow", "error");
		}
	}
	async function executeFlow(flowId: string, input: string) {
		const flow = flows.find((f) => f.id === flowId);
		if (!flow) return;
		setRunning(true);
		try {
			const res = await apiFetch(`/api/flows/${flowId}/execute`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input, mode: "peers" }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			if (data.executionId) {
				const agents = walkAgents(flow);
				startFlowInChat(
					data.executionId,
					"",
					flow.id,
					flow.name,
					agents.map((a) => ({ id: a.id, name: a.name, role: a.role })),
					input,
				);
				await loadExecutions();
			}
		} catch {
			showToast("Failed to start flow", "error");
		} finally {
			setRunning(false);
		}
	}
	async function saveFlow(flow: FlowDef) {
		try {
			if (flow.isTemplate) {
				await apiFetch("/api/flows", {
					method: "POST",
					body: JSON.stringify({
						...flow,
						isTemplate: false,
						name: flow.name + " (custom)",
					}),
				});
				showToast("Flow created from template", "success");
			} else {
				await apiFetch(`/api/flows/${flow.id}`, {
					method: "PUT",
					body: JSON.stringify(flow),
				});
				showToast("Flow saved", "success");
			}
			loadFlows();
			setEditingFlow(null);
			setView("list");
		} catch {
			showToast("Failed to save flow", "error");
		}
	}
	function createNewFlow() {
		const now = new Date().toISOString();
		setEditingFlow({
			id: "",
			name: "New Flow",
			description: "Custom agent flow",
			version: "1.0.0",
			isTemplate: false,
			createdAt: now,
			updatedAt: now,
			entryAgentId: "agent-1",
			agents: {
				"agent-1": {
					id: "agent-1",
					name: "Agent 1",
					role: "First agent",
					systemPrompt: "You are a helpful assistant.",
					inputTemplate: "{{prev_output}}",
					allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
					mcpServers: [],
					maxTurns: 20,
					timeoutMs: 300000,
					outputParser: "raw",
					transitions: { default: "END" },
				},
			},
		});
		setView("edit");
	}

	const selectedFlow = flows.find((f) => f.id === selectedFlowId);
	const flowExecs = executions
		.filter((e) => e.flowId === selectedFlowId)
		.sort(
			(a, b) =>
				new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
		);

	// ── LIST VIEW ──
	if (view === "list") {
		const templates = flows.filter((f) => f.isTemplate);
		const userFlows = flows.filter((f) => !f.isTemplate);
		// Recent completed/failed executions for the "Recent Activity" section
		const recentExecs = executions
			.filter((e) => e.status === "completed" || e.status === "failed")
			.sort(
				(a, b) =>
					new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
			)
			.slice(0, 5);

		return (
			<div class="flows-section">
				<div class="flows-header">
					<h2>Orchestrator</h2>
					<button class="btn btn-primary" onClick={createNewFlow}>
						<IconPlus size={14} /> New Flow
					</button>
				</div>

				{/* Active execution — always first, prominent */}
				{isAnyFlowRunning && liveFlow && (
					<ActiveFlowBanner
						flow={liveFlow}
						onOpen={() => {
							const f =
								flows.find((fl) => fl.id === liveFlow.flowId) ??
								flows.find((fl) => fl.name === liveFlow.flowName);
							if (f) {
								setSelectedFlowId(f.id);
								setView("run");
							}
						}}
					/>
				)}
				{!isAnyFlowRunning &&
					executions.some((e) => e.status === "running") && (
						<div class="flow-active-banner flow-active-stale">
							<span class="spinner-sm" />
							<span>A flow is running in the background.</span>
							<button
								class="btn btn-ghost"
								onClick={() => {
									const r = executions.find((e) => e.status === "running");
									const f = r ? flows.find((fl) => fl.id === r.flowId) : null;
									if (f) {
										setSelectedFlowId(f.id);
										setView("run");
									}
								}}
							>
								View
							</button>
						</div>
					)}

				{/* Templates — primary */}
				{templates.length > 0 && (
					<div class="flows-group">
						<h3 class="flows-group-title">Flow Templates</h3>
						<div class="flows-grid">
							{templates.map((f) => (
								<FlowCard
									key={f.id}
									flow={f}
									onSelect={() => {
										setSelectedFlowId(f.id);
										setView("run");
									}}
									onEdit={() => {
										setEditingFlow({ ...f });
										setView("edit");
									}}
									onDelete={() => deleteFlow(f.id)}
								/>
							))}
						</div>
					</div>
				)}
				{userFlows.length > 0 && (
					<div class="flows-group">
						<h3 class="flows-group-title">My Flows</h3>
						<div class="flows-grid">
							{userFlows.map((f) => (
								<FlowCard
									key={f.id}
									flow={f}
									onSelect={() => {
										setSelectedFlowId(f.id);
										setView("run");
									}}
									onEdit={() => {
										setEditingFlow({ ...f });
										setView("edit");
									}}
									onDelete={() => deleteFlow(f.id)}
								/>
							))}
						</div>
					</div>
				)}
				{flows.length === 0 && (
					<div class="flows-empty">
						<p>No flows yet. Create one or wait for templates to load.</p>
					</div>
				)}

				{/* Recent activity — last */}
				{recentExecs.length > 0 && (
					<div class="flows-group">
						<h3 class="flows-group-title">Recent Executions</h3>
						<div class="flows-recent-list">
							{recentExecs.map((exec) => {
								const f = flows.find((fl) => fl.id === exec.flowId);
								const elapsed = exec.completedAt
									? Math.round(
											(new Date(exec.completedAt).getTime() -
												new Date(exec.startedAt).getTime()) /
												1000,
										)
									: 0;
								const agentCount = Object.keys(exec.agentResults || {}).length;
								return (
									<div
										key={exec.id}
										class="flows-recent-item"
										onClick={() => {
											if (f) {
												setSelectedFlowId(f.id);
												setSelectedExecId(exec.id);
												setView("run");
											}
										}}
									>
										<span class={`flows-recent-status ${exec.status}`}>
											{exec.status === "completed" ? "\u2713" : "\u2717"}
										</span>
										<div class="flows-recent-info">
											<span class="flows-recent-name">
												{f?.name || "Unknown flow"}
											</span>
											<span class="flows-recent-meta">
												{agentCount} agents &middot; {formatDuration(elapsed)}{" "}
												&middot; {new Date(exec.startedAt).toLocaleString()}
											</span>
										</div>
									</div>
								);
							})}
						</div>
					</div>
				)}
			</div>
		);
	}

	// ── EDIT VIEW (Visual Canvas) ──
	if (view === "edit" && editingFlow) {
		return (
			<FlowCanvas
				flow={editingFlow}
				systemAgents={systemAgents}
				onChange={setEditingFlow}
				onSave={() => saveFlow(editingFlow)}
				onCancel={() => {
					setEditingFlow(null);
					setView("list");
				}}
			/>
		);
	}

	// ── RUN VIEW (Execution Viewer) ──
	if (view === "run" && selectedFlow) {
		const liveFlow = activeFlowExecution.value;

		// All flows now use peer mode — show PeerExecutionViewer whenever
		// there's an active running flow. Don't wait for peerSessions to
		// populate (they arrive async via WS after agents spawn).
		if (liveFlow && liveFlow.status === "running") {
			const goBack = () => {
				setSelectedFlowId(null);
				setSelectedExecId(null);
				setView("list");
			};
			return (
				<PeerExecutionViewer
					executionId={liveFlow.executionId}
					onCancel={async () => {
						try {
							await apiFetch(
								`/api/flows/executions/${liveFlow.executionId}/cancel`,
								{ method: "POST" },
							);
						} catch {
							/* */
						}
						goBack();
					}}
					onBack={goBack}
				/>
			);
		}

		return (
			<ExecutionViewer
				flow={selectedFlow}
				executions={flowExecs}
				initialExecId={selectedExecId}
				runInput={runInput}
				running={running}
				onInputChange={setRunInput}
				onRun={() => executeFlow(selectedFlow.id, runInput)}
				onBack={() => {
					setSelectedFlowId(null);
					setSelectedExecId(null);
					setView("list");
				}}
				onEdit={() => {
					setEditingFlow({ ...selectedFlow });
					setView("edit");
				}}
			/>
		);
	}

	return null;
}

// ══════════════════════════════════════════
// ══ EXECUTION VIEWER (three-zone layout)
// ══════════════════════════════════════════

function ExecutionViewer({
	flow,
	executions,
	initialExecId,
	runInput,
	running,
	onInputChange,
	onRun,
	onBack,
	onEdit,
}: {
	flow: FlowDef;
	executions: FlowExecution[];
	initialExecId?: string | null;
	runInput: string;
	running: boolean;
	onInputChange: (v: string) => void;
	onRun: () => void;
	onBack: () => void;
	onEdit: () => void;
}) {
	const [submittedInput, setSubmittedInput] = useState("");
	const [showInputView, setShowInputView] = useState(false);
	const [viewingExecId, setViewingExecId] = useState<string | null>(
		initialExecId ?? null,
	);
	const agents = walkAgents(flow);
	const liveFlow = activeFlowExecution.value;

	// Reset showInputView when a new execution starts
	useEffect(() => {
		if (activeFlowExecution.value?.status === "running")
			setShowInputView(false);
	}, [activeFlowExecution.value?.status]);

	// When a live flow completes, switch to viewing it so the result stays visible
	useEffect(() => {
		if (
			liveFlow &&
			liveFlow.status !== "running" &&
			liveFlow.flowId === flow.id
		) {
			setViewingExecId(liveFlow.executionId);
		}
	}, [liveFlow?.status]);
	const recentExecIds = new Set(executions.map((e) => e.id));

	// Check both live signal AND server executions for running state
	const liveIsForThisFlow =
		liveFlow != null &&
		(recentExecIds.has(liveFlow.executionId) ||
			liveFlow.flowId === flow.id ||
			liveFlow.flowName === flow.name);
	const serverRunning = executions.find((e) => e.status === "running");
	const isRunning =
		(liveIsForThisFlow && liveFlow!.status === "running") || !!serverRunning;

	// Build src: prefer live > viewing selected execution > archived
	const viewingExec = viewingExecId
		? executions.find((e) => e.id === viewingExecId)
		: null;
	const viewingArch = viewingExecId
		? Object.values(archivedFlows.value).find(
				(f) => f.executionId === viewingExecId,
			)
		: null;

	// Build a full ActiveFlowState from a server-side execution
	const execStartMs = viewingExec
		? new Date(viewingExec.startedAt).getTime()
		: 0;
	const viewingSrc =
		viewingExec && !viewingArch
			? {
					executionId: viewingExec.id,
					conversationId: "",
					flowId: flow.id,
					flowName: flow.name,
					initialInput: viewingExec.initialInput || "",
					status: viewingExec.status as
						| "running"
						| "completed"
						| "failed"
						| "cancelled",
					agents: agents.map((a) => ({ id: a.id, name: a.name })),
					currentAgentId: null as string | null,
					currentAgentIndex: agents.length,
					startedAt: execStartMs,
					completedAt: viewingExec.completedAt
						? new Date(viewingExec.completedAt).getTime()
						: null,
					agentOutputs: Object.fromEntries(
						Object.entries(viewingExec.agentResults).map(([id, r]) => [
							id,
							r.output || "",
						]),
					),
					agentDurations: Object.fromEntries(
						Object.entries(viewingExec.agentResults).map(([id, r]) => [
							id,
							r.startedAt && r.completedAt
								? new Date(r.completedAt).getTime() -
									new Date(r.startedAt).getTime()
								: 0,
						]),
					),
					agentDecisions: {} as Record<string, string>,
					agentStartedAt: {} as Record<string, number>,
					loopCount: 0,
					visitLog: Object.entries(viewingExec.agentResults).map(([id, r]) => ({
						agentId: id,
						agentName: agents.find((a) => a.id === id)?.name || id,
						visit: 1,
						output: r.output || "",
						duration: undefined as number | undefined,
						decision: undefined as string | undefined,
						startedAt: execStartMs,
						status: (r.status === "completed" ? "completed" : "failed") as
							| "running"
							| "completed"
							| "failed",
					})),
				}
			: null;

	// Only show execution data when: live flow is running, or user explicitly selected one.
	// Never auto-show old executions — the default view is the input prompt.
	const src = liveIsForThisFlow
		? liveFlow
		: (viewingArch ?? viewingSrc ?? null);
	const isComplete = !!src && !isRunning;
	const outputRef = useRef<HTMLDivElement>(null);
	const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());

	useEffect(() => {
		if (outputRef.current)
			outputRef.current.scrollTop = outputRef.current.scrollHeight;
	}, [liveFlow?.agentOutputs, liveFlow?.currentAgentId]);

	function toggleExpand(id: string) {
		setExpandedAgents((prev) => {
			const n = new Set(prev);
			if (n.has(id)) n.delete(id);
			else n.add(id);
			return n;
		});
	}

	async function cancelFlow() {
		if (!src?.executionId) return;
		try {
			await apiFetch(`/api/flows/executions/${src.executionId}/cancel`, {
				method: "POST",
			});
		} catch {
			/* */
		}
	}

	return (
		<div class="exec-viewer">
			{/* Zone 1: Pipeline */}
			<div class="exec-pipeline">
				<button
					class="btn btn-ghost exec-back"
					onClick={onBack}
					title="Back to flows"
					aria-label="Back to flows"
				>
					&larr; Back
				</button>
				<div class="exec-pipeline-nodes">
					{agents.map((agent, i) => {
						const isCurrent = src?.currentAgentId === agent.id;
						const isDone = src?.agentDurations[agent.id] != null;
						const decision = src?.agentDecisions[agent.id];
						let cls = "exec-node-pending";
						if (isDone) cls = "exec-node-done";
						else if (isCurrent && isRunning) cls = "exec-node-running";
						return (
							<div key={agent.id} class="exec-node-wrap">
								<div class={`exec-node ${cls}`} title={agent.role}>
									<div class="exec-node-icon">
										{isDone && "\u2713"}
										{isCurrent && isRunning && <span class="spinner-sm" />}
										{!isDone && !(isCurrent && isRunning) && i + 1}
									</div>
									<div class="exec-node-info">
										<span class="exec-node-name">{agent.name}</span>
										{isCurrent &&
											isRunning &&
											src?.agentStartedAt[agent.id] && (
												<FlowTimer startedAt={src.agentStartedAt[agent.id]} />
											)}
										{isDone && (
											<span class="exec-node-dur">
												{formatDuration(
													(src?.agentDurations[agent.id] || 0) / 1000,
												)}
											</span>
										)}
									</div>
									{decision && (
										<span
											class={`exec-decision exec-decision-${decision.toLowerCase()}`}
										>
											{decision}
										</span>
									)}
								</div>
								{i < agents.length - 1 && (
									<svg
										class="exec-arrow"
										width="20"
										height="12"
										viewBox="0 0 20 12"
									>
										<path
											d="M0 6h16M13 2l4 4-4 4"
											stroke="currentColor"
											stroke-width="1.5"
											fill="none"
										/>
									</svg>
								)}
							</div>
						);
					})}
					{/* Loop indicator — show if flow definition has conditional transitions (loop-capable) */}
					{(() => {
						const hasLoop = agents.some((a) =>
							a.transitions.conditions?.some((c) => {
								const target = c.goto;
								return (
									target !== "END" &&
									agents.findIndex((x) => x.id === target) <
										agents.findIndex((x) => x.id === a.id)
								);
							}),
						);
						const loopCount = src?.loopCount || 0;
						if (!hasLoop) return null;
						return (
							<div
								class={`exec-loop-indicator${loopCount > 0 ? " exec-loop-active" : ""}`}
							>
								<svg
									class="exec-loop-arrow"
									viewBox="0 0 120 28"
									width="120"
									height="28"
								>
									<path
										d="M100 2 C110 2, 115 10, 115 14 C115 18, 110 26, 100 26 L20 26 C10 26, 5 18, 5 14 L5 14"
										stroke="currentColor"
										stroke-width="1.5"
										fill="none"
										stroke-dasharray="4 3"
									/>
									<path
										d="M2 10 L5 14 L8 10"
										stroke="currentColor"
										stroke-width="1.5"
										fill="none"
									/>
								</svg>
								<span class="exec-loop-badge">
									{loopCount > 0
										? `\u21BB Loop ${loopCount}`
										: "\u21BB Loop capable"}
								</span>
							</div>
						);
					})()}
				</div>
				{!isRunning && !isComplete && (
					<button class="btn btn-ghost" onClick={onEdit}>
						<IconEdit size={14} />
					</button>
				)}
			</div>

			{/* Zone 2: Execution Log — renders from visitLog */}
			{(isRunning || isComplete) && (
				<div
					class={`exec-log${isRunning ? " exec-log-running" : ""}`}
					ref={outputRef}
				>
					{(
						src?.initialInput ||
						submittedInput ||
						executions[0]?.initialInput ||
						""
					).trim() && (
						<div class="exec-log-entry exec-log-user">
							<div class="exec-log-label">Task</div>
							<div class="exec-log-text">
								{src?.initialInput ||
									submittedInput ||
									executions[0]?.initialInput}
							</div>
						</div>
					)}
					{src?.visitLog.map((visit, i) => {
						const prevVisit = i > 0 ? src.visitLog[i - 1] : null;
						const isActive = visit.status === "running" && isRunning;
						const isDone = visit.status === "completed";
						const visitKey = `${visit.agentId}-v${visit.visit}`;
						const isExpanded = expandedAgents.has(visitKey);

						return (
							<div key={visitKey}>
								{/* Transition between agents */}
								{prevVisit && prevVisit.agentId !== visit.agentId && (
									<div class="exec-log-transition">
										{prevVisit.agentName} {"\u2192"} {visit.agentName}
										{prevVisit.decision && (
											<span
												class={`exec-log-decision exec-log-decision-${prevVisit.decision.toLowerCase().replace(/_/g, "-")}`}
											>
												{prevVisit.decision}
											</span>
										)}
									</div>
								)}
								{/* Loop marker — same agent running again */}
								{prevVisit &&
									prevVisit.agentId === visit.agentId &&
									visit.visit > 1 && (
										<div class="exec-log-loop-marker">
											{"\u21BB"} Loop {visit.visit - 1} — {visit.agentName}{" "}
											re-evaluating
										</div>
									)}
								{/* Agent visit card — click anywhere to expand/collapse */}
								<div
									class={`exec-log-entry exec-log-agent${isActive ? " exec-log-active" : ""}`}
									onClick={isDone ? () => toggleExpand(visitKey) : undefined}
									style={isDone ? { cursor: "pointer" } : undefined}
								>
									<div class="exec-log-header">
										{isActive && <span class="spinner-sm" />}
										{isDone && <span class="exec-log-check">{"\u2713"}</span>}
										<span class="exec-log-name">
											{visit.agentName}
											{visit.visit > 1 && (
												<span class="exec-log-visit-num">
													{" "}
													(pass {visit.visit})
												</span>
											)}
										</span>
										{isActive && <FlowTimer startedAt={visit.startedAt} />}
										{isDone && visit.duration != null && (
											<span class="exec-log-dur">
												{formatDuration(visit.duration / 1000)}
											</span>
										)}
										{visit.decision && (
											<span
												class={`exec-log-decision exec-log-decision-${visit.decision.toLowerCase().replace(/_/g, "-")}`}
											>
												{visit.decision}
											</span>
										)}
										{isDone && (
											<span class="exec-log-expand">
												{isExpanded ? "\u25BC" : "\u25B6"}
											</span>
										)}
									</div>
									{/* Active: always show streaming output */}
									{isActive && visit.output && (
										<pre class="exec-log-output">
											{visit.output.slice(-3000)}
											<span class="chat-cursor">{"\u2588"}</span>
										</pre>
									)}
									{/* Completed + expanded: full output */}
									{isDone && isExpanded && visit.output && (
										<pre class="exec-log-output">{visit.output}</pre>
									)}
									{/* Completed + collapsed: preview */}
									{isDone && !isExpanded && visit.output && (
										<div class="exec-log-preview">
											{visit.output
												.trim()
												.split("\n")
												.slice(0, 2)
												.join(" ")
												.slice(0, 150)}
											...
										</div>
									)}
								</div>
							</div>
						);
					})}
					{isComplete && src && (
						<div
							class={`exec-log-entry exec-log-summary${src.status !== "completed" ? " exec-log-failed" : ""}`}
						>
							<span>{src.status === "completed" ? "\u2713" : "\u2717"}</span>
							<strong>
								Flow {src.status} in{" "}
								{formatDuration(
									((src.completedAt || Date.now()) - src.startedAt) / 1000,
								)}
								{src.loopCount > 0 &&
									` \u2014 ${src.loopCount} loop${src.loopCount > 1 ? "s" : ""}`}
							</strong>
						</div>
					)}
				</div>
			)}

			{/* Zone 3: Controls */}
			<div class="exec-controls">
				{((!isRunning && !isComplete) || showInputView) && (
					<>
						<textarea
							class="exec-input"
							placeholder={
								flow.name.includes("Review")
									? "What file or area should be reviewed? e.g. 'Review apps/runtime/src/services/flow-runner.ts for bugs and security issues'"
									: flow.name.includes("TDD")
										? "What feature or behavior should be implemented? e.g. 'Add pagination to the conversation listing endpoint'"
										: flow.name.includes("Fullstack") ||
												flow.name.includes("Production")
											? "Describe the feature to build end-to-end. e.g. 'Build a user settings page with theme toggle and notification preferences'"
											: "Describe what you want this flow to do..."
							}
							value={runInput}
							onInput={(e) =>
								onInputChange((e.target as HTMLTextAreaElement).value)
							}
							onKeyDown={(e) => {
								if (
									(e.metaKey || e.ctrlKey) &&
									e.key === "Enter" &&
									runInput.trim() &&
									!running
								) {
									e.preventDefault();
									setSubmittedInput(runInput);
									setShowInputView(false);
									onRun();
								}
							}}
							rows={3}
						/>
						<button
							class="btn btn-primary"
							disabled={!runInput.trim() || running}
							onClick={() => {
								setSubmittedInput(runInput);
								setShowInputView(false);
								onRun();
							}}
						>
							<IconPlay size={14} /> {running ? "Starting..." : "Run"}
						</button>
					</>
				)}
				{running && !isRunning && (
					<div class="exec-status-bar">
						<span class="spinner-sm" />
						<span>Starting flow — initializing agents...</span>
					</div>
				)}
				{isRunning && (
					<div class="exec-status-bar">
						<span class="spinner-sm" />
						{src ? (
							<span>
								Step {src.visitLog.length}
								{src.loopCount > 0 && ` (loop ${src.loopCount})`} —{" "}
								<strong>
									{agents.find((a) => a.id === src.currentAgentId)?.name ||
										"..."}
								</strong>{" "}
								working
							</span>
						) : (
							<span>Flow running — waiting for agent output...</span>
						)}
						<button class="btn btn-ghost exec-cancel" onClick={cancelFlow}>
							Cancel
						</button>
					</div>
				)}
				{isComplete && !showInputView && (
					<div class="exec-status-bar">
						<span>{src?.status === "completed" ? "\u2713" : "\u2717"}</span>
						<span>Flow {src?.status}</span>
						<button
							class="btn btn-primary"
							onClick={() => {
								setViewingExecId(null);
								setShowInputView(true);
								onInputChange("");
							}}
						>
							Run Again
						</button>
					</div>
				)}
			</div>

			{/* Past executions — hidden during active run */}
			{!isRunning && executions.length > 0 && (
				<details class="flow-past-execs">
					<summary>Past executions ({executions.length})</summary>
					{executions.slice(0, 5).map((e) => (
						<ExecutionRow
							key={e.id}
							execution={e}
							onSelect={setViewingExecId}
						/>
					))}
				</details>
			)}
		</div>
	);
}
