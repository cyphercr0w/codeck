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
		const cursor = queue.shift()!;
		if (visited.has(cursor) || !flow.agents[cursor]) continue;
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
		startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
	);
	useEffect(() => {
		if (!startedAt) return;
		setElapsed(Math.floor((Date.now() - startedAt) / 1000));
		const iv = setInterval(
			() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
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

export function FlowsSection() {
	const [flows, setFlows] = useState<FlowDef[]>([]);
	const [executions, setExecutions] = useState<FlowExecution[]>([]);
	const [systemAgents, setSystemAgents] = useState<SystemAgent[]>([]);
	const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
	const [editingFlow, setEditingFlow] = useState<FlowDef | null>(null);
	const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
	const [runInput, setRunInput] = useState("");
	const [running, setRunning] = useState(false);
	const [view, setView] = useState<"list" | "edit" | "run">("list");

	const liveFlow = activeFlowExecution.value;
	const isAnyFlowRunning = liveFlow?.status === "running";

	useEffect(() => {
		loadFlows();
		loadExecutions();
		loadSystemAgents();
	}, []);
	useEffect(() => {
		if (!isAnyFlowRunning) {
			loadExecutions();
			return;
		}
		const iv = setInterval(loadExecutions, 5000);
		return () => clearInterval(iv);
	}, [isAnyFlowRunning]);

	async function loadFlows() {
		try {
			const r = await apiFetch("/api/flows");
			const d = await r.json();
			setFlows(d.flows || []);
		} catch {
			/* */
		}
	}
	async function loadExecutions() {
		try {
			const r = await apiFetch("/api/flows/executions/list");
			const d = await r.json();
			setExecutions(d.executions || []);
		} catch {
			/* */
		}
	}
	async function loadSystemAgents() {
		try {
			const r = await apiFetch("/api/flows/available-agents");
			const d = await r.json();
			setSystemAgents(d.agents || []);
		} catch {
			/* */
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
			const data = await res.json();
			if (data.executionId) {
				const agents = walkAgents(flow);
				startFlowInChat(
					data.executionId,
					"",
					flow.name,
					agents.map((a) => ({ id: a.id, name: a.name, role: a.role })),
				);
				loadExecutions();
			}
		} catch {
			showToast("Failed to start flow", "error");
		}
		setRunning(false);
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
		return (
			<div class="flows-section">
				<div class="flows-header">
					<h2>Orchestrator</h2>
					<button class="btn btn-primary" onClick={createNewFlow}>
						<IconPlus size={14} /> New Flow
					</button>
				</div>
				{isAnyFlowRunning && liveFlow && (
					<ActiveFlowBanner
						flow={liveFlow}
						onOpen={() => {
							const f = flows.find((fl) => fl.name === liveFlow.flowName);
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
				{templates.length > 0 && (
					<div class="flows-group">
						<h3 class="flows-group-title">Templates</h3>
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
	const agents = walkAgents(flow);
	const liveFlow = activeFlowExecution.value;
	// Match archived flows by executionId from recent executions for this flow,
	// rather than by flowName (which breaks on rename and is ambiguous).
	const recentExecIds = new Set(executions.map((e) => e.id));
	const archived = Object.values(archivedFlows.value).find((f) =>
		recentExecIds.has(f.executionId),
	);
	const src = liveFlow?.flowName === flow.name ? liveFlow : archived;
	const isRunning =
		liveFlow?.flowName === flow.name && liveFlow?.status === "running";
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
													(src!.agentDurations[agent.id] || 0) / 1000,
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
					{src && src.loopCount > 0 && (
						<span class="exec-loop-badge">Loop {src.loopCount}</span>
					)}
				</div>
				{!isRunning && !isComplete && (
					<button class="btn btn-ghost" onClick={onEdit}>
						<IconEdit size={14} />
					</button>
				)}
			</div>

			{/* Zone 2: Execution Log */}
			{(isRunning || isComplete) && (
				<div
					class={`exec-log${isRunning ? " exec-log-running" : ""}`}
					ref={outputRef}
				>
					{runInput.trim() && (
						<div class="exec-log-entry exec-log-user">
							<div class="exec-log-label">Your prompt</div>
							<div class="exec-log-text">{runInput}</div>
						</div>
					)}
					{src &&
						agents.map((agent, i) => {
							const out = src.agentOutputs[agent.id];
							const dur = src.agentDurations[agent.id];
							const decision = src.agentDecisions[agent.id];
							const isCurrent = src.currentAgentId === agent.id;
							const isDone = dur != null;
							const isExpanded = expandedAgents.has(agent.id);
							if (!out && !isCurrent && !isDone) return null;
							return (
								<div key={`${agent.id}-${i}`}>
									{i > 0 && (out || isCurrent || isDone) && (
										<div class="exec-log-transition">
											{agents[i - 1].name} {"\u2192"} {agent.name}
											{i > 0 && src.agentDecisions[agents[i - 1].id] && (
												<span class="exec-log-decision">
													{src.agentDecisions[agents[i - 1].id]}
												</span>
											)}
										</div>
									)}
									<div
										class={`exec-log-entry exec-log-agent${isCurrent && isRunning ? " exec-log-active" : ""}`}
									>
										<div
											class="exec-log-header"
											onClick={() =>
												isDone && !isCurrent
													? toggleExpand(agent.id)
													: undefined
											}
										>
											{isCurrent && isRunning && <span class="spinner-sm" />}
											{isDone && <span class="exec-log-check">{"\u2713"}</span>}
											<span class="exec-log-name">{agent.name}</span>
											{isCurrent &&
												isRunning &&
												src.agentStartedAt[agent.id] && (
													<FlowTimer startedAt={src.agentStartedAt[agent.id]} />
												)}
											{isDone && (
												<span class="exec-log-dur">
													{Math.round(dur / 1000)}s
												</span>
											)}
											{isDone && !isCurrent && (
												<span class="exec-log-expand">
													{isExpanded ? "\u25BC" : "\u25B6"}
												</span>
											)}
										</div>
										{isCurrent && isRunning && out && (
											<pre class="exec-log-output">
												{out.slice(-3000)}
												<span class="chat-cursor">{"\u2588"}</span>
											</pre>
										)}
										{isDone && !isCurrent && isExpanded && out && (
											<pre class="exec-log-output">{out}</pre>
										)}
										{isDone && !isCurrent && !isExpanded && out && (
											<div class="exec-log-preview">
												{out
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
								{Math.round((Date.now() - src.startedAt) / 1000)}s
								{src.loopCount > 0 &&
									` \u2014 ${src.loopCount} loop${src.loopCount > 1 ? "s" : ""}`}
							</strong>
						</div>
					)}
				</div>
			)}

			{/* Zone 3: Controls */}
			<div class="exec-controls">
				{!isRunning && !isComplete && (
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
							onClick={onRun}
						>
							<IconPlay size={14} /> {running ? "Starting..." : "Run"}
						</button>
					</>
				)}
				{isRunning && src && (
					<div class="exec-status-bar">
						<span class="spinner-sm" />
						<span>
							Agent {(src.currentAgentIndex || 0) + 1}/{agents.length} —{" "}
							<strong>
								{agents.find((a) => a.id === src.currentAgentId)?.name || "..."}
							</strong>{" "}
							working
						</span>
						<button class="btn btn-ghost exec-cancel" onClick={cancelFlow}>
							Cancel
						</button>
					</div>
				)}
				{isComplete && (
					<div class="exec-status-bar">
						<span>{src?.status === "completed" ? "\u2713" : "\u2717"}</span>
						<span>Flow {src?.status}</span>
						<button
							class="btn btn-primary"
							onClick={() => {
								// Clear archived state so the UI resets to the input view
								if (src?.executionId) {
									const updated = { ...archivedFlows.value };
									delete updated[src.executionId];
									archivedFlows.value = updated;
								}
								onInputChange("");
							}}
						>
							Run Again
						</button>
					</div>
				)}
			</div>

			{/* Past executions */}
			{executions.length > 0 && (
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
	const [elapsed, setElapsed] = useState(0);
	useEffect(() => {
		const iv = setInterval(
			() => setElapsed(Math.floor((Date.now() - flow.startedAt) / 1000)),
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
		const id = `agent-${agents.length + 1}`;
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
