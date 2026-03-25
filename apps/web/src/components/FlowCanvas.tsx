/**
 * FlowCanvas — Visual node-based flow editor using @xyflow/react
 *
 * n8n-style canvas for building agent orchestration flows.
 * Each node is a configurable agent panel, edges represent transitions.
 */

import {
	useState,
	useCallback,
	useMemo,
	useEffect,
	useRef,
} from "preact/hooks";
import {
	ReactFlow,
	Background,
	Controls,
	MiniMap,
	addEdge,
	applyNodeChanges,
	applyEdgeChanges,
	Handle,
	Position,
	BaseEdge,
	getBezierPath,
	EdgeLabelRenderer,
	MarkerType,
	type Node,
	type Edge,
	type OnNodesChange,
	type OnEdgesChange,
	type OnConnect,
	type Connection,
	type NodeProps,
	type EdgeProps,
	type XYPosition,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { IconPlus, IconX, IconTrash, IconCheck } from "./Icons";

// ── Types (shared with FlowsSection) ──

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

// ── Agent Node Data ──

interface AgentNodeData {
	agent: AgentDef;
	isEntry: boolean;
	onSelect: (id: string) => void;
	[key: string]: unknown;
}

type AgentNode = Node<AgentNodeData>;

// ── Custom Agent Node ──

function AgentNodeComponent({ id, data, selected }: NodeProps<AgentNode>) {
	const { agent, isEntry } = data;
	const toolCount = agent.allowedTools.length;
	const hasConditions = (agent.transitions.conditions?.length ?? 0) > 0;

	return (
		<div
			class={`canvas-agent-node${selected ? " selected" : ""}${isEntry ? " entry" : ""}`}
			onDblClick={() => data.onSelect(id)}
		>
			<Handle
				type="target"
				position={Position.Left}
				className="canvas-handle"
			/>

			{isEntry && <div class="canvas-entry-badge">ENTRY</div>}

			<div class="canvas-node-header">
				<span class="canvas-node-name">{agent.name}</span>
				{agent.outputParser === "structured" && (
					<span class="canvas-node-tag" title="Structured output (DECISION)">
						DECISION
					</span>
				)}
			</div>

			<div class="canvas-node-role">{agent.role}</div>

			<div class="canvas-node-meta">
				<span title="Tools">{toolCount} tools</span>
				<span title="Max turns">{agent.maxTurns}t</span>
				<span title="Timeout">{Math.round(agent.timeoutMs / 1000)}s</span>
			</div>

			{/* Default output handle */}
			<Handle
				type="source"
				position={Position.Right}
				id="default"
				className="canvas-handle canvas-handle-out"
			/>

			{/* Conditional output handles */}
			{hasConditions &&
				agent.transitions.conditions!.map((c, i) => (
					<Handle
						key={c.when}
						type="source"
						position={Position.Right}
						id={`cond-${c.when}`}
						className="canvas-handle canvas-handle-cond"
						style={{ top: `${60 + (i + 1) * 20}%` }}
					/>
				))}
		</div>
	);
}

// ── Custom Transition Edge ──

function TransitionEdge(props: EdgeProps) {
	const {
		id,
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		data,
		selected,
	} = props;

	const [edgePath, labelX, labelY] = getBezierPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
	});

	const label = (data as Record<string, unknown>)?.label as string | undefined;

	return (
		<>
			<BaseEdge
				id={id}
				path={edgePath}
				style={{
					stroke: selected ? "var(--accent, #6366f1)" : "var(--border, #333)",
					strokeWidth: selected ? 2.5 : 1.5,
				}}
			/>
			{label && label !== "default" && (
				<EdgeLabelRenderer>
					<div
						className="canvas-edge-label nodrag nopan"
						style={{
							position: "absolute",
							transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
						}}
					>
						{label}
					</div>
				</EdgeLabelRenderer>
			)}
		</>
	);
}

// ── Layout: Auto-position nodes ──

function autoLayout(flow: FlowDef): Record<string, XYPosition> {
	const positions: Record<string, XYPosition> = {};
	const visited = new Set<string>();
	const queue: Array<{ id: string; col: number }> = [];
	const colCounts: Record<number, number> = {};

	queue.push({ id: flow.entryAgentId, col: 0 });
	colCounts[0] = 0;

	while (queue.length > 0) {
		const { id, col } = queue.shift()!;
		if (visited.has(id) || !flow.agents[id]) continue;
		visited.add(id);

		const row = colCounts[col] ?? 0;
		colCounts[col] = row + 1;

		positions[id] = { x: col * 340, y: row * 220 };

		const agent = flow.agents[id];
		if (agent.transitions.default && agent.transitions.default !== "END") {
			const nextCol = col + 1;
			if (!(nextCol in colCounts)) colCounts[nextCol] = 0;
			queue.push({ id: agent.transitions.default, col: nextCol });
		}
		if (agent.transitions.conditions) {
			for (const cond of agent.transitions.conditions) {
				if (cond.goto !== "END" && !visited.has(cond.goto)) {
					const nextCol = col + 1;
					if (!(nextCol in colCounts)) colCounts[nextCol] = 0;
					queue.push({ id: cond.goto, col: nextCol });
				}
			}
		}
	}

	// Disconnected agents
	let extraRow = Math.max(0, ...Object.values(colCounts)) + 1;
	for (const id of Object.keys(flow.agents)) {
		if (!visited.has(id)) {
			positions[id] = { x: 0, y: extraRow * 220 };
			extraRow++;
		}
	}

	return positions;
}

// ── Convert FlowDef ↔ ReactFlow nodes/edges ──

function flowToGraph(
	flow: FlowDef,
	selectedAgentId: string | null,
	onSelect: (id: string) => void,
): { nodes: AgentNode[]; edges: Edge[] } {
	const positions = autoLayout(flow);
	const nodes: AgentNode[] = [];
	const edges: Edge[] = [];

	for (const [agentId, agent] of Object.entries(flow.agents)) {
		nodes.push({
			id: agentId,
			type: "agentNode",
			position: positions[agentId] || { x: 0, y: 0 },
			data: {
				agent,
				isEntry: agentId === flow.entryAgentId,
				onSelect,
			},
			selected: agentId === selectedAgentId,
		});

		if (agent.transitions.default && agent.transitions.default !== "END") {
			edges.push({
				id: `${agentId}->default->${agent.transitions.default}`,
				source: agentId,
				target: agent.transitions.default,
				sourceHandle: "default",
				type: "transition",
				data: { label: "default" },
				markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
			});
		}

		if (agent.transitions.conditions) {
			for (const cond of agent.transitions.conditions) {
				if (cond.goto !== "END") {
					edges.push({
						id: `${agentId}->cond-${cond.when}->${cond.goto}`,
						source: agentId,
						target: cond.goto,
						sourceHandle: `cond-${cond.when}`,
						type: "transition",
						animated: true,
						data: { label: cond.when },
						markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
					});
				}
			}
		}
	}

	return { nodes, edges };
}

// ── Node/edge type registries (stable reference) ──

const nodeTypes = { agentNode: AgentNodeComponent };
const edgeTypes = { transition: TransitionEdge };

// ══════════════════════════════════════════
// ══ MAIN CANVAS COMPONENT
// ══════════════════════════════════════════

export function FlowCanvas({
	flow,
	systemAgents,
	onChange,
	onSave,
	onCancel,
}: {
	flow: FlowDef;
	systemAgents: SystemAgent[];
	onChange: (flow: FlowDef) => void;
	onSave: () => void;
	onCancel: () => void;
}) {
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const [showPicker, setShowPicker] = useState(false);
	const isFirstRender = useRef(true);

	const onSelect = useCallback((id: string) => {
		setSelectedAgentId((prev) => (prev === id ? null : id));
	}, []);

	// Build graph representation
	const graph = useMemo(
		() => flowToGraph(flow, selectedAgentId, onSelect),
		[flow, selectedAgentId, onSelect],
	);

	const [nodes, setNodes] = useState<AgentNode[]>(graph.nodes);
	const [edges, setEdges] = useState<Edge[]>(graph.edges);

	// Sync graph when flow data changes (from property panel edits)
	// Preserve node positions from current canvas state
	useEffect(() => {
		if (isFirstRender.current) {
			isFirstRender.current = false;
			return;
		}
		setNodes((prev) => {
			const posMap = new Map(prev.map((n) => [n.id, n.position]));
			return graph.nodes.map((n) => ({
				...n,
				position: posMap.get(n.id) ?? n.position,
			}));
		});
		setEdges(graph.edges);
	}, [flow, selectedAgentId]);

	const onNodesChange: OnNodesChange<AgentNode> = useCallback(
		(changes) =>
			setNodes((nds) => applyNodeChanges(changes, nds) as AgentNode[]),
		[],
	);

	const onEdgesChange: OnEdgesChange = useCallback(
		(changes) => setEdges((eds) => applyEdgeChanges(changes, eds)),
		[],
	);

	// New connection drawn by user
	const onConnect: OnConnect = useCallback(
		(conn: Connection) => {
			if (!conn.source || !conn.target) return;
			const sourceAgent = flow.agents[conn.source];
			if (!sourceAgent) return;

			const updated = { ...flow.agents };
			const a = { ...sourceAgent };

			if (conn.sourceHandle === "default" || !conn.sourceHandle) {
				a.transitions = { ...a.transitions, default: conn.target };
			} else if (conn.sourceHandle?.startsWith("cond-")) {
				const condName = conn.sourceHandle.replace("cond-", "");
				const conds = [...(a.transitions.conditions || [])];
				const idx = conds.findIndex((c) => c.when === condName);
				if (idx >= 0) conds[idx] = { ...conds[idx], goto: conn.target };
				else conds.push({ when: condName, goto: conn.target });
				a.transitions = { ...a.transitions, conditions: conds };
			}

			updated[conn.source] = a;
			onChange({ ...flow, agents: updated });
			setEdges((eds) => addEdge(conn, eds));
		},
		[flow, onChange],
	);

	const onNodeClick = useCallback((_: any, node: AgentNode) => {
		setSelectedAgentId((prev) => (prev === node.id ? null : node.id));
	}, []);

	const onPaneClick = useCallback(() => setSelectedAgentId(null), []);

	// Edge deletion → update flow transitions
	const onEdgesDelete = useCallback(
		(deleted: Edge[]) => {
			const updated = { ...flow.agents };
			for (const edge of deleted) {
				const agent = updated[edge.source];
				if (!agent) continue;
				const u = { ...agent };
				if (edge.sourceHandle === "default" || !edge.sourceHandle) {
					u.transitions = { ...u.transitions, default: "END" };
				} else if (edge.sourceHandle?.startsWith("cond-")) {
					const condName = edge.sourceHandle.replace("cond-", "");
					u.transitions = {
						...u.transitions,
						conditions: (u.transitions.conditions || []).filter(
							(c) => c.when !== condName,
						),
					};
				}
				updated[edge.source] = u;
			}
			onChange({ ...flow, agents: updated });
		},
		[flow, onChange],
	);

	// Node deletion → remove agent from flow
	const onNodesDelete = useCallback(
		(deleted: AgentNode[]) => {
			const removing = new Set(deleted.map((n) => n.id));
			if (Object.keys(flow.agents).length - removing.size < 1) return;

			const updated: Record<string, AgentDef> = {};
			for (const [id, agent] of Object.entries(flow.agents)) {
				if (removing.has(id)) continue;
				let t = { ...agent.transitions };
				if (t.default && removing.has(t.default)) t = { ...t, default: "END" };
				if (t.conditions)
					t = {
						...t,
						conditions: t.conditions.filter((c) => !removing.has(c.goto)),
					};
				updated[id] = { ...agent, transitions: t };
			}
			const newEntry = removing.has(flow.entryAgentId)
				? Object.keys(updated)[0]
				: flow.entryAgentId;
			onChange({ ...flow, agents: updated, entryAgentId: newEntry });
			if (selectedAgentId && removing.has(selectedAgentId))
				setSelectedAgentId(null);
		},
		[flow, onChange, selectedAgentId],
	);

	// ── Agent CRUD ──

	const selectedAgent = selectedAgentId ? flow.agents[selectedAgentId] : null;
	const allAgentIds = Object.keys(flow.agents);

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
			? `${sa.id}-${allAgentIds.length + 1}`
			: sa.id;
		const updated = { ...flow.agents };
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
		setSelectedAgentId(uniqueId);
		setShowPicker(false);
	}

	function addBlankAgent() {
		const id = `agent-${crypto.randomUUID().slice(0, 8)}`;
		const updated = { ...flow.agents };
		updated[id] = {
			id,
			name: `Agent ${allAgentIds.length + 1}`,
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
		setSelectedAgentId(id);
		setShowPicker(false);
	}

	function removeSelectedAgent() {
		if (!selectedAgentId || allAgentIds.length <= 1) return;
		const updated: Record<string, AgentDef> = {};
		for (const [id, agent] of Object.entries(flow.agents)) {
			if (id === selectedAgentId) continue;
			let t = { ...agent.transitions };
			if (t.default === selectedAgentId) t = { ...t, default: "END" };
			if (t.conditions)
				t = {
					...t,
					conditions: t.conditions.filter((c) => c.goto !== selectedAgentId),
				};
			updated[id] = { ...agent, transitions: t };
		}
		const newEntry =
			flow.entryAgentId === selectedAgentId
				? Object.keys(updated)[0]
				: flow.entryAgentId;
		onChange({ ...flow, agents: updated, entryAgentId: newEntry });
		setSelectedAgentId(null);
	}

	function addCondition() {
		if (!selectedAgentId) return;
		const agent = flow.agents[selectedAgentId];
		if (!agent) return;
		const conds = [...(agent.transitions.conditions || [])];
		conds.push({ when: "CONDITION", goto: "END" });
		updateAgent(selectedAgentId, {
			transitions: { ...agent.transitions, conditions: conds },
			outputParser: "structured",
			structuredOutputSchema: agent.structuredOutputSchema || {
				decisionField: "decision",
				decisionsEnum: conds.map((c) => c.when),
			},
		});
	}

	function removeCondition(idx: number) {
		if (!selectedAgentId) return;
		const agent = flow.agents[selectedAgentId];
		if (!agent) return;
		const conds = (agent.transitions.conditions || []).filter(
			(_, i) => i !== idx,
		);
		updateAgent(selectedAgentId, {
			transitions: { ...agent.transitions, conditions: conds },
		});
	}

	function updateCondition(
		idx: number,
		updates: Partial<{ when: string; goto: string }>,
	) {
		if (!selectedAgentId) return;
		const agent = flow.agents[selectedAgentId];
		if (!agent) return;
		const conds = [...(agent.transitions.conditions || [])];
		conds[idx] = { ...conds[idx], ...updates };
		const newSchema =
			agent.outputParser === "structured"
				? {
						...(agent.structuredOutputSchema || {
							decisionField: "decision",
							decisionsEnum: [],
						}),
						decisionsEnum: conds.map((c) => c.when),
					}
				: agent.structuredOutputSchema;
		updateAgent(selectedAgentId, {
			transitions: { ...agent.transitions, conditions: conds },
			structuredOutputSchema: newSchema,
		});
	}

	return (
		<div class="flow-canvas-container">
			{/* ── Top bar ── */}
			<div class="flow-canvas-topbar">
				<button class="btn btn-ghost" onClick={onCancel}>
					&larr; Back
				</button>
				<div class="flow-canvas-meta">
					<input
						type="text"
						class="flow-canvas-name nodrag"
						value={flow.name}
						onInput={(e) =>
							onChange({ ...flow, name: (e.target as HTMLInputElement).value })
						}
						placeholder="Flow name"
					/>
					<input
						type="text"
						class="flow-canvas-desc nodrag"
						value={flow.description}
						onInput={(e) =>
							onChange({
								...flow,
								description: (e.target as HTMLInputElement).value,
							})
						}
						placeholder="Description"
					/>
				</div>
				<button class="btn btn-primary" onClick={onSave}>
					<IconCheck size={14} /> Save
				</button>
			</div>

			{/* ── Canvas + Panel ── */}
			<div class="flow-canvas-body">
				<div class="flow-canvas-main">
					<ReactFlow
						nodes={nodes}
						edges={edges}
						onNodesChange={onNodesChange}
						onEdgesChange={onEdgesChange}
						onConnect={onConnect}
						onNodeClick={onNodeClick}
						onPaneClick={onPaneClick}
						onEdgesDelete={onEdgesDelete}
						onNodesDelete={onNodesDelete}
						nodeTypes={nodeTypes}
						edgeTypes={edgeTypes}
						fitView
						snapToGrid
						snapGrid={[20, 20]}
						deleteKeyCode="Delete"
						defaultEdgeOptions={{
							type: "transition",
							markerEnd: {
								type: MarkerType.ArrowClosed,
								width: 16,
								height: 16,
							},
						}}
					>
						<Background gap={20} size={1} />
						<Controls showInteractive={false} />
						<MiniMap
							zoomable
							pannable
							style={{ background: "var(--bg-secondary, #111)" }}
						/>
					</ReactFlow>

					{/* Add agent FAB */}
					<button
						class="flow-canvas-fab"
						onClick={() => setShowPicker(true)}
						title="Add agent node"
					>
						<IconPlus size={18} /> Add Agent
					</button>

					{/* Agent picker overlay */}
					{showPicker && (
						<CanvasAgentPicker
							systemAgents={systemAgents}
							onSelect={addAgentFromSystem}
							onBlank={() => {
								addBlankAgent();
								setShowPicker(false);
							}}
							onClose={() => setShowPicker(false)}
						/>
					)}
				</div>

				{/* ── Property Panel ── */}
				{selectedAgent && selectedAgentId && (
					<div class="flow-canvas-panel">
						<div class="flow-canvas-panel-head">
							<h3>{selectedAgent.name}</h3>
							<button class="btn-icon" onClick={() => setSelectedAgentId(null)}>
								<IconX size={14} />
							</button>
						</div>
						<div class="flow-canvas-panel-scroll">
							{/* Name + Role */}
							<div class="form-field">
								<label>Name</label>
								<input
									type="text"
									value={selectedAgent.name}
									onInput={(e) =>
										updateAgent(selectedAgentId, {
											name: (e.target as HTMLInputElement).value,
										})
									}
								/>
							</div>
							<div class="form-field">
								<label>Role</label>
								<input
									type="text"
									value={selectedAgent.role}
									onInput={(e) =>
										updateAgent(selectedAgentId, {
											role: (e.target as HTMLInputElement).value,
										})
									}
								/>
							</div>

							{/* System Prompt */}
							<details open>
								<summary>System Prompt</summary>
								<textarea
									class="flow-panel-textarea"
									value={selectedAgent.systemPrompt}
									onInput={(e) =>
										updateAgent(selectedAgentId, {
											systemPrompt: (e.target as HTMLTextAreaElement).value,
										})
									}
									rows={6}
								/>
							</details>

							{/* Input Template */}
							<details>
								<summary>Input Template</summary>
								<textarea
									class="flow-panel-textarea"
									value={selectedAgent.inputTemplate}
									onInput={(e) =>
										updateAgent(selectedAgentId, {
											inputTemplate: (e.target as HTMLTextAreaElement).value,
										})
									}
									rows={3}
									placeholder="{{prev_output}}"
								/>
							</details>

							{/* Tools */}
							<details open>
								<summary>Tools ({selectedAgent.allowedTools.length})</summary>
								<div class="flow-panel-tools">
									{ALL_TOOLS.map((t) => (
										<label key={t} class="flow-panel-tool-check">
											<input
												type="checkbox"
												checked={selectedAgent.allowedTools.includes(t)}
												onChange={(e) => {
													const c = (e.target as HTMLInputElement).checked;
													updateAgent(selectedAgentId, {
														allowedTools: c
															? [...selectedAgent.allowedTools, t]
															: selectedAgent.allowedTools.filter(
																	(x) => x !== t,
																),
													});
												}}
											/>
											{t}
										</label>
									))}
								</div>
							</details>

							{/* Numbers */}
							<div class="form-row">
								<div class="form-field">
									<label>Max Turns</label>
									<input
										type="number"
										value={selectedAgent.maxTurns}
										onInput={(e) =>
											updateAgent(selectedAgentId, {
												maxTurns:
													parseInt((e.target as HTMLInputElement).value) || 20,
											})
										}
										min={1}
										max={200}
									/>
								</div>
								<div class="form-field">
									<label>Timeout (s)</label>
									<input
										type="number"
										value={Math.round(selectedAgent.timeoutMs / 1000)}
										onInput={(e) =>
											updateAgent(selectedAgentId, {
												timeoutMs:
													(parseInt((e.target as HTMLInputElement).value) ||
														300) * 1000,
											})
										}
										min={30}
										max={3600}
									/>
								</div>
							</div>

							{/* Output Parser */}
							<div class="form-field">
								<label>Output Parser</label>
								<select
									value={selectedAgent.outputParser}
									onChange={(e) =>
										updateAgent(selectedAgentId, {
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

							{/* Default Transition */}
							<div class="form-field">
								<label>Default Transition</label>
								<select
									value={selectedAgent.transitions.default || "END"}
									onChange={(e) =>
										updateAgent(selectedAgentId, {
											transitions: {
												...selectedAgent.transitions,
												default: (e.target as HTMLSelectElement).value,
											},
										})
									}
								>
									<option value="END">END</option>
									{allAgentIds
										.filter((id) => id !== selectedAgentId)
										.map((id) => (
											<option key={id} value={id}>
												{flow.agents[id]?.name || id}
											</option>
										))}
								</select>
							</div>

							{/* Conditional Transitions */}
							<details
								open={(selectedAgent.transitions.conditions?.length ?? 0) > 0}
							>
								<summary>
									Conditions (
									{selectedAgent.transitions.conditions?.length ?? 0})
								</summary>
								{selectedAgent.transitions.conditions?.map((cond, i) => (
									<div key={i} class="flow-panel-condition">
										<input
											type="text"
											value={cond.when}
											onInput={(e) =>
												updateCondition(i, {
													when: (
														e.target as HTMLInputElement
													).value.toUpperCase(),
												})
											}
											placeholder="WHEN"
											class="flow-panel-cond-when"
										/>
										<span class="flow-panel-cond-arrow">&rarr;</span>
										<select
											value={cond.goto}
											onChange={(e) =>
												updateCondition(i, {
													goto: (e.target as HTMLSelectElement).value,
												})
											}
										>
											<option value="END">END</option>
											{allAgentIds
												.filter((id) => id !== selectedAgentId)
												.map((id) => (
													<option key={id} value={id}>
														{flow.agents[id]?.name || id}
													</option>
												))}
										</select>
										<button
											class="btn-icon btn-danger btn-sm"
											onClick={() => removeCondition(i)}
										>
											<IconTrash size={12} />
										</button>
									</div>
								))}
								<button class="btn btn-ghost btn-sm" onClick={addCondition}>
									<IconPlus size={12} /> Add Condition
								</button>
							</details>

							{/* Actions */}
							<div class="flow-panel-actions">
								{selectedAgentId !== flow.entryAgentId && (
									<button
										class="btn btn-ghost btn-sm"
										onClick={() =>
											onChange({
												...flow,
												entryAgentId: selectedAgentId,
											})
										}
									>
										Set as Entry Point
									</button>
								)}
								{allAgentIds.length > 1 && (
									<button
										class="btn btn-ghost btn-sm btn-danger"
										onClick={removeSelectedAgent}
									>
										<IconTrash size={12} /> Remove Agent
									</button>
								)}
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

// ── Agent Picker (overlay) ──

function CanvasAgentPicker({
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
		<div class="flow-canvas-picker-overlay" onClick={onClose}>
			<div class="flow-canvas-picker" onClick={(e) => e.stopPropagation()}>
				<div class="flow-canvas-picker-head">
					<input
						type="text"
						placeholder="Search agents..."
						value={search}
						onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
						autoFocus
					/>
					<button class="btn-icon" onClick={onClose}>
						<IconX size={14} />
					</button>
				</div>
				<div class="flow-canvas-picker-list">
					<button class="flow-canvas-picker-item blank" onClick={onBlank}>
						<IconPlus size={14} />
						<div>
							<strong>Blank Agent</strong>
							<span>Custom agent from scratch</span>
						</div>
					</button>
					{filtered.map((a) => (
						<button
							key={a.id}
							class="flow-canvas-picker-item"
							onClick={() => onSelect(a)}
						>
							<div>
								<strong>{a.name}</strong>
								<span>{a.description.slice(0, 80)}</span>
							</div>
						</button>
					))}
					{filtered.length === 0 && search && (
						<div class="flow-canvas-picker-empty">
							No agents match "{search}"
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
