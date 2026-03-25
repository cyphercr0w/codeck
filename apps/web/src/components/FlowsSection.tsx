import { useState, useEffect, useRef } from "preact/hooks";
import { apiFetch } from "../api";
import { showToast } from "../state/store";
import {
	activeFlowExecution,
	archivedFlows,
	startFlowInChat,
} from "../state/chat-store";
import {
	IconPlus,
	IconPlay,
	IconTrash,
	IconEdit,
	IconX,
	IconChevronDown,
	IconChevronUp,
	IconCheck,
} from "./Icons";

// ── Types ──

interface SystemAgent {
	id: string;
	name: string;
	description: string;
	tools: string[];
}

interface AgentDef {
	id: string;
	name: string;
	role: string;
	systemPrompt: string;
	inputTemplate: string;
	allowedTools: string[];
	mcpServers: string[];
	maxTurns: number;
	timeoutMs: number;
	outputParser: "raw" | "structured";
	structuredOutputSchema?: { decisionField: string; decisionsEnum: string[] };
	transitions: {
		default?: string | "END";
		conditions?: Array<{ when: string; goto: string | "END" }>;
	};
}

interface FlowDef {
	id: string;
	name: string;
	description: string;
	version: string;
	isTemplate: boolean;
	createdAt: string;
	updatedAt: string;
	entryAgentId: string;
	agents: Record<string, AgentDef>;
}

interface FlowExecution {
	id: string;
	flowId: string;
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	currentAgentId: string | null;
	startedAt: string;
	completedAt: string | null;
	agentResults: Record<
		string,
		{ agentId: string; status: string; output: string }
	>;
}

const ALL_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Glob",
	"Grep",
	"WebSearch",
	"WebFetch",
];

function walkAgents(flow: FlowDef): AgentDef[] {
	const ordered: AgentDef[] = [];
	const visited = new Set<string>();
	const queue: string[] = [flow.entryAgentId];
	while (queue.length > 0) {
		const cursor = queue.shift();
		if (!cursor || visited.has(cursor) || !flow.agents[cursor]) continue;
		ordered.push(flow.agents[cursor]);
		visited.add(cursor);
		// Follow default transition
		const next = flow.agents[cursor].transitions.default;
		if (typeof next === "string" && next !== "END") {
			queue.push(next);
		}
		// Follow conditional transitions
		const conds = flow.agents[cursor].transitions.conditions;
		if (conds) {
			for (const cond of conds) {
				if (cond.goto !== "END") {
					queue.push(cond.goto);
				}
			}
		}
	}
	return ordered;
}

// ── Elapsed Timer ──

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
	const [editingFlow, setEditingFlow] = useState<FlowDef | null>(null);
	const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
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
				body: JSON.stringify({ input }),
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
		setEditingAgentId("agent-1");
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
										setEditingAgentId(f.entryAgentId);
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
												{agentCount} agents &middot; {elapsed}s &middot;{" "}
												{new Date(exec.startedAt).toLocaleString()}
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

	// ── EDIT VIEW ──
	if (view === "edit" && editingFlow) {
		return (
			<FlowEditor
				flow={editingFlow}
				activeAgentId={editingAgentId}
				systemAgents={systemAgents}
				onAgentSelect={setEditingAgentId}
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
		return (
			<ExecutionViewer
				flow={selectedFlow}
				executions={flowExecs}
				runInput={runInput}
				running={running}
				onInputChange={setRunInput}
				onRun={() => executeFlow(selectedFlow.id, runInput)}
				onBack={() => {
					setSelectedFlowId(null);
					setView("list");
				}}
				onEdit={() => {
					setEditingFlow({ ...selectedFlow });
					setEditingAgentId(selectedFlow.entryAgentId);
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
	runInput,
	running,
	onInputChange,
	onRun,
	onBack,
	onEdit,
}: {
	flow: FlowDef;
	executions: FlowExecution[];
	runInput: string;
	running: boolean;
	onInputChange: (v: string) => void;
	onRun: () => void;
	onBack: () => void;
	onEdit: () => void;
}) {
	const [submittedInput, setSubmittedInput] = useState("");
	const [showInputView, setShowInputView] = useState(false);
	const agents = walkAgents(flow);
	// Reset showInputView when a new execution starts
	useEffect(() => {
		if (activeFlowExecution.value?.status === "running")
			setShowInputView(false);
	}, [activeFlowExecution.value?.status]);
	const liveFlow = activeFlowExecution.value;
	const recentExecIds = new Set(executions.map((e) => e.id));
	const archived =
		Object.values(archivedFlows.value)
			.filter((f) => recentExecIds.has(f.executionId))
			.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;

	// Check both live signal AND server executions for running state
	const liveIsForThisFlow =
		liveFlow != null &&
		(recentExecIds.has(liveFlow.executionId) ||
			liveFlow.flowId === flow.id ||
			liveFlow.flowName === flow.name);
	const serverRunning = executions.find((e) => e.status === "running");
	const isRunning =
		(liveIsForThisFlow && liveFlow!.status === "running") || !!serverRunning;
	const src = liveIsForThisFlow ? liveFlow : archived;
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
				<button class="btn btn-ghost exec-back" onClick={onBack}>
					&larr;
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
												{Math.round(
													(src?.agentDurations[agent.id] || 0) / 1000,
												)}
												s
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
					{(src?.initialInput || submittedInput).trim() && (
						<div class="exec-log-entry exec-log-user">
							<div class="exec-log-label">Your prompt</div>
							<div class="exec-log-text">
								{src?.initialInput || submittedInput}
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
												{Math.round(visit.duration / 1000)}s
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
						<div class="exec-log-entry exec-log-summary">
							<span>{src.status === "completed" ? "\u2713" : "\u2717"}</span>
							<strong>
								Flow {src.status} in{" "}
								{Math.round(
									((src.completedAt || Date.now()) - src.startedAt) / 1000,
								)}
								s
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
							placeholder="Describe what you want this flow to do..."
							value={runInput}
							onInput={(e) =>
								onInputChange((e.target as HTMLTextAreaElement).value)
							}
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
				{isRunning && (
					<div class="exec-status-bar">
						<span class="spinner-sm" />
						{src ? (
							<span>
								Agent {(src.currentAgentIndex || 0) + 1}/{agents.length} —{" "}
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
						<ExecutionRow key={e.id} execution={e} />
					))}
				</details>
			)}
		</div>
	);
}

// ══════════════════════════════════════════
// ══ ACTIVE FLOW BANNER
// ══════════════════════════════════════════

function ActiveFlowBanner({
	flow,
	onOpen,
}: {
	flow: {
		flowName: string;
		agents: Array<{ id: string; name: string }>;
		currentAgentId: string | null;
		agentDurations: Record<string, number>;
		agentOutputs: Record<string, string>;
		startedAt: number;
	};
	onOpen: () => void;
}) {
	const [elapsed, setElapsed] = useState(() =>
		Math.max(0, Math.floor((Date.now() - flow.startedAt) / 1000)),
	);
	useEffect(() => {
		const iv = setInterval(
			() =>
				setElapsed(
					Math.max(0, Math.floor((Date.now() - flow.startedAt) / 1000)),
				),
			1000,
		);
		return () => clearInterval(iv);
	}, [flow.startedAt]);
	const currentAgent = flow.agents.find((a) => a.id === flow.currentAgentId);
	const doneCount = Object.keys(flow.agentDurations).length;
	const lastOutput = flow.currentAgentId
		? flow.agentOutputs[flow.currentAgentId] || ""
		: "";
	const lastLine = lastOutput.trim().split("\n").pop()?.slice(0, 120) || "";
	return (
		<div class="flow-active-banner" onClick={onOpen}>
			<div class="flow-active-top">
				<span class="spinner-sm" />
				<strong>{flow.flowName}</strong>
				<span class="flow-active-progress">
					{doneCount}/{flow.agents.length} agents
				</span>
				<span class="flow-active-time">{elapsed}s</span>
			</div>
			<div class="flow-active-detail">
				{currentAgent && (
					<span class="flow-active-agent">
						Running: <strong>{currentAgent.name}</strong>
					</span>
				)}
				{lastLine && <span class="flow-active-preview">{lastLine}</span>}
			</div>
			<div class="flow-active-nodes">
				{flow.agents.map((a) => {
					const isDone = flow.agentDurations[a.id] != null;
					const isCurrent = flow.currentAgentId === a.id;
					return (
						<span
							key={a.id}
							class={`flow-active-dot${isDone ? " done" : isCurrent ? " current" : ""}`}
							title={a.name}
						/>
					);
				})}
			</div>
		</div>
	);
}

// ══════════════════════════════════════════
// ══ FLOW CARD
// ══════════════════════════════════════════

function FlowCard({
	flow,
	onSelect,
	onEdit,
	onDelete,
}: {
	flow: FlowDef;
	onSelect: () => void;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const agentCount = Object.keys(flow.agents).length;
	return (
		<div class="flow-card" onClick={onSelect}>
			<div class="flow-card-header">
				<span class="flow-card-name">{flow.name}</span>
				{flow.isTemplate && <span class="flow-card-badge">Template</span>}
			</div>
			<p class="flow-card-desc">{flow.description}</p>
			<div class="flow-card-meta">
				<span>
					{agentCount} agent{agentCount !== 1 ? "s" : ""}
				</span>
				<span>v{flow.version}</span>
			</div>
			<div class="flow-card-actions" onClick={(e) => e.stopPropagation()}>
				<button class="btn-icon" onClick={onEdit} title="Edit">
					<IconEdit size={14} />
				</button>
				{!flow.isTemplate && (
					<button
						class="btn-icon btn-danger"
						onClick={() => {
							if (confirm(`Delete flow "${flow.name}"?`)) onDelete();
						}}
						title="Delete"
					>
						<IconTrash size={14} />
					</button>
				)}
			</div>
		</div>
	);
}

// ══════════════════════════════════════════
// ══ FLOW EDITOR
// ══════════════════════════════════════════

function FlowEditor({
	flow,
	activeAgentId,
	systemAgents,
	onAgentSelect,
	onChange,
	onSave,
	onCancel,
}: {
	flow: FlowDef;
	activeAgentId: string | null;
	systemAgents: SystemAgent[];
	onAgentSelect: (id: string | null) => void;
	onChange: (flow: FlowDef) => void;
	onSave: () => void;
	onCancel: () => void;
}) {
	const agents = Object.values(flow.agents);
	const activeAgent = activeAgentId ? flow.agents[activeAgentId] : null;
	const [showAgentPicker, setShowAgentPicker] = useState(false);

	function updateAgent(agentId: string, updates: Partial<AgentDef>) {
		onChange({
			...flow,
			agents: {
				...flow.agents,
				[agentId]: { ...flow.agents[agentId], ...updates },
			},
		});
	}
	function addAgentFromSystem(sa: SystemAgent) {
		const uniqueId = flow.agents[sa.id]
			? `${sa.id}-${agents.length + 1}`
			: sa.id;
		const last = agents[agents.length - 1];
		const updated = { ...flow.agents };
		if (last?.transitions.default === "END")
			updated[last.id] = {
				...last,
				transitions: { ...last.transitions, default: uniqueId },
			};
		updated[uniqueId] = {
			id: uniqueId,
			name: sa.name,
			role: sa.description.slice(0, 100),
			systemPrompt: `You are the ${sa.name} agent. ${sa.description}`,
			inputTemplate: "{{prev_output}}",
			allowedTools:
				sa.tools.length > 0
					? sa.tools.filter((t) => !t.startsWith("mcp__"))
					: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
			mcpServers: [],
			maxTurns: 20,
			timeoutMs: 300000,
			outputParser: "raw",
			transitions: { default: "END" },
		};
		onChange({ ...flow, agents: updated });
		onAgentSelect(uniqueId);
		setShowAgentPicker(false);
	}
	function addBlankAgent() {
		const id = `agent-${crypto.randomUUID().slice(0, 8)}`;
		const last = agents[agents.length - 1];
		const updated = { ...flow.agents };
		if (last?.transitions.default === "END")
			updated[last.id] = {
				...last,
				transitions: { ...last.transitions, default: id },
			};
		updated[id] = {
			id,
			name: `Agent ${agents.length + 1}`,
			role: "Describe this agent's role",
			systemPrompt: "You are a helpful assistant.",
			inputTemplate: "{{prev_output}}",
			allowedTools: ["Read", "Write", "Edit", "Bash"],
			mcpServers: [],
			maxTurns: 20,
			timeoutMs: 300000,
			outputParser: "raw",
			transitions: { default: "END" },
		};
		onChange({ ...flow, agents: updated });
		onAgentSelect(id);
	}
	function removeAgent(id: string) {
		if (agents.length <= 1) return;
		const updated: Record<string, AgentDef> = {};
		for (const [key, orig] of Object.entries(flow.agents)) {
			if (key === id) continue;
			let t = { ...orig.transitions };
			if (t.default === id) t = { ...t, default: "END" };
			if (t.conditions)
				t = {
					...t,
					conditions: t.conditions.map((c) =>
						c.goto === id ? { ...c, goto: "END" } : c,
					),
				};
			updated[key] = { ...orig, transitions: t };
		}
		const newEntry =
			flow.entryAgentId === id ? Object.keys(updated)[0] : flow.entryAgentId;
		onChange({ ...flow, agents: updated, entryAgentId: newEntry });
		onAgentSelect(newEntry);
	}

	return (
		<div class="flows-section">
			<div class="flows-header">
				<button class="btn btn-ghost" onClick={onCancel}>
					&larr; Cancel
				</button>
				<h2>{flow.id ? "Edit Flow" : "New Flow"}</h2>
				<button class="btn btn-primary" onClick={onSave}>
					<IconCheck size={14} /> Save
				</button>
			</div>
			<div class="flow-editor">
				<div class="flow-editor-meta">
					<div class="form-field">
						<label>Name</label>
						<input
							type="text"
							value={flow.name}
							onInput={(e) =>
								onChange({
									...flow,
									name: (e.target as HTMLInputElement).value,
								})
							}
						/>
					</div>
					<div class="form-field">
						<label>Description</label>
						<input
							type="text"
							value={flow.description}
							onInput={(e) =>
								onChange({
									...flow,
									description: (e.target as HTMLInputElement).value,
								})
							}
						/>
					</div>
				</div>
				<div class="flow-editor-layout">
					<div class="flow-editor-agents">
						<div class="flow-editor-agents-header">
							<h3>Agents</h3>
							<button
								class="btn-icon"
								onClick={() => setShowAgentPicker(true)}
								title="Add agent"
							>
								<IconPlus size={14} />
							</button>
						</div>
						{showAgentPicker && (
							<AgentPicker
								systemAgents={systemAgents}
								onSelect={addAgentFromSystem}
								onBlank={() => {
									addBlankAgent();
									setShowAgentPicker(false);
								}}
								onClose={() => setShowAgentPicker(false)}
							/>
						)}
						{agents.map((a, i) => (
							<div
								key={a.id}
								class={`flow-editor-agent-item${activeAgentId === a.id ? " active" : ""}`}
								onClick={() => onAgentSelect(a.id)}
							>
								<span class="flow-editor-agent-num">{i + 1}</span>
								<div class="flow-editor-agent-info">
									<span class="flow-editor-agent-name">{a.name}</span>
									<span class="flow-editor-agent-role">{a.role}</span>
								</div>
								{agents.length > 1 && (
									<button
										class="btn-icon btn-danger btn-sm"
										onClick={(e) => {
											e.stopPropagation();
											removeAgent(a.id);
										}}
										title="Remove"
									>
										<IconX size={12} />
									</button>
								)}
							</div>
						))}
					</div>
					{activeAgent && (
						<AgentEditor
							agent={activeAgent}
							allAgentIds={agents.map((a) => a.id)}
							onChange={(u) => updateAgent(activeAgent.id, u)}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

// ══════════════════════════════════════════
// ══ AGENT EDITOR
// ══════════════════════════════════════════

function AgentEditor({
	agent,
	allAgentIds,
	onChange,
}: {
	agent: AgentDef;
	allAgentIds: string[];
	onChange: (u: Partial<AgentDef>) => void;
}) {
	const [showPrompt, setShowPrompt] = useState(true);
	return (
		<div class="flow-agent-editor">
			<div class="form-field">
				<label>Name</label>
				<input
					type="text"
					value={agent.name}
					onInput={(e) =>
						onChange({ name: (e.target as HTMLInputElement).value })
					}
				/>
			</div>
			<div class="form-field">
				<label>Role</label>
				<input
					type="text"
					value={agent.role}
					onInput={(e) =>
						onChange({ role: (e.target as HTMLInputElement).value })
					}
				/>
			</div>
			<div class="form-field">
				<button
					class="btn btn-ghost btn-sm"
					onClick={() => setShowPrompt(!showPrompt)}
				>
					System Prompt{" "}
					{showPrompt ? (
						<IconChevronUp size={12} />
					) : (
						<IconChevronDown size={12} />
					)}
				</button>
				{showPrompt && (
					<textarea
						class="flow-agent-prompt"
						value={agent.systemPrompt}
						onInput={(e) =>
							onChange({
								systemPrompt: (e.target as HTMLTextAreaElement).value,
							})
						}
						rows={8}
					/>
				)}
			</div>
			<div class="form-field">
				<label>Input Template</label>
				<textarea
					value={agent.inputTemplate}
					onInput={(e) =>
						onChange({ inputTemplate: (e.target as HTMLTextAreaElement).value })
					}
					rows={3}
					placeholder="Use {{prev_output}} for previous agent's output"
				/>
			</div>
			<div class="form-field">
				<label>Tools</label>
				<div class="flow-agent-tools">
					{ALL_TOOLS.map((t) => (
						<label key={t} class="flow-agent-tool-check">
							<input
								type="checkbox"
								checked={agent.allowedTools.includes(t)}
								onChange={(e) => {
									const c = (e.target as HTMLInputElement).checked;
									onChange({
										allowedTools: c
											? [...agent.allowedTools, t]
											: agent.allowedTools.filter((x) => x !== t),
									});
								}}
							/>
							{t}
						</label>
					))}
				</div>
			</div>
			<div class="form-row">
				<div class="form-field">
					<label>Max Turns</label>
					<input
						type="number"
						value={agent.maxTurns}
						onInput={(e) =>
							onChange({
								maxTurns: parseInt((e.target as HTMLInputElement).value) || 20,
							})
						}
						min={1}
						max={200}
					/>
				</div>
				<div class="form-field">
					<label>Timeout (sec)</label>
					<input
						type="number"
						value={Math.round(agent.timeoutMs / 1000)}
						onInput={(e) =>
							onChange({
								timeoutMs:
									(parseInt((e.target as HTMLInputElement).value) || 300) *
									1000,
							})
						}
						min={30}
						max={3600}
					/>
				</div>
			</div>
			<div class="form-field">
				<label>Output Parser</label>
				<select
					value={agent.outputParser}
					onChange={(e) =>
						onChange({
							outputParser: (e.target as HTMLSelectElement).value as
								| "raw"
								| "structured",
						})
					}
				>
					<option value="raw">Raw</option>
					<option value="structured">Structured (DECISION)</option>
				</select>
			</div>
			<div class="form-field">
				<label>Default Transition</label>
				<select
					value={agent.transitions.default || "END"}
					onChange={(e) =>
						onChange({
							transitions: {
								...agent.transitions,
								default: (e.target as HTMLSelectElement).value,
							},
						})
					}
				>
					<option value="END">END</option>
					{allAgentIds
						.filter((id) => id !== agent.id)
						.map((id) => (
							<option key={id} value={id}>
								{id}
							</option>
						))}
				</select>
			</div>
		</div>
	);
}

// ══════════════════════════════════════════
// ══ AGENT PICKER
// ══════════════════════════════════════════

function AgentPicker({
	systemAgents,
	onSelect,
	onBlank,
	onClose,
}: {
	systemAgents: SystemAgent[];
	onSelect: (a: SystemAgent) => void;
	onBlank: () => void;
	onClose: () => void;
}) {
	const [search, setSearch] = useState("");
	const filtered = systemAgents.filter(
		(a) =>
			a.name.toLowerCase().includes(search.toLowerCase()) ||
			a.description.toLowerCase().includes(search.toLowerCase()),
	);
	return (
		<div class="agent-picker">
			<div class="agent-picker-header">
				<input
					type="text"
					class="agent-picker-search"
					placeholder="Search agents..."
					value={search}
					onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
					autoFocus
				/>
				<button class="btn-icon" onClick={onClose}>
					<IconX size={14} />
				</button>
			</div>
			<div class="agent-picker-list">
				<button
					class="agent-picker-item agent-picker-blank"
					onClick={() => {
						onBlank();
						onClose();
					}}
				>
					<IconPlus size={14} />
					<div>
						<strong>Blank Agent</strong>
						<span>Custom agent from scratch</span>
					</div>
				</button>
				{filtered.map((a) => (
					<button
						key={a.id}
						class="agent-picker-item"
						onClick={() => onSelect(a)}
					>
						<div class="agent-picker-item-info">
							<strong>{a.name}</strong>
							<span>{a.description.slice(0, 80)}</span>
						</div>
						{a.tools.length > 0 && (
							<span class="agent-picker-tools">
								{a.tools.filter((t) => !t.startsWith("mcp__")).length} tools
							</span>
						)}
					</button>
				))}
				{filtered.length === 0 && search && (
					<div class="agent-picker-empty">No agents match "{search}"</div>
				)}
			</div>
		</div>
	);
}

// ══════════════════════════════════════════
// ══ EXECUTION ROW (past executions)
// ══════════════════════════════════════════

function ExecutionRow({ execution }: { execution: FlowExecution }) {
	const [expanded, setExpanded] = useState(false);
	const elapsed = execution.completedAt
		? new Date(execution.completedAt).getTime() -
			new Date(execution.startedAt).getTime()
		: Date.now() - new Date(execution.startedAt).getTime();
	const statusColor: Record<string, string> = {
		completed: "var(--success, #22c55e)",
		failed: "var(--error)",
		running: "var(--accent)",
		pending: "var(--text-muted)",
		cancelled: "var(--text-muted)",
	};
	return (
		<div class="flow-execution-row">
			<div class="flow-execution-header" onClick={() => setExpanded(!expanded)}>
				<span
					class="flow-execution-status"
					style={{ color: statusColor[execution.status] || "inherit" }}
				>
					{execution.status}
				</span>
				<span class="flow-execution-time">
					{new Date(execution.startedAt).toLocaleString()}
				</span>
				<span class="flow-execution-duration">
					{elapsed < 60000
						? `${Math.round(elapsed / 1000)}s`
						: `${Math.round(elapsed / 60000)}m`}
				</span>
				{expanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
			</div>
			{expanded && (
				<div class="flow-execution-details">
					{Object.entries(execution.agentResults).map(([id, r]) => (
						<div key={id} class="flow-execution-agent">
							<strong>{id}</strong>: {r.status}
							{r.output && (
								<pre class="flow-execution-output">
									{r.output.slice(0, 500)}
								</pre>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
