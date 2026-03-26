/**
 * FlowCanvas — Visual node-based flow editor using @xyflow/react
 *
 * n8n-style canvas for building agent orchestration flows.
 * Each node is a configurable agent panel, edges represent transitions.
 */

import { useState, useCallback, useMemo, useEffect } from "preact/hooks";
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
	MarkerType,
	useViewport,
	type Node,
	type Edge,
	type OnNodesChange,
	type OnEdgesChange,
	type OnConnect,
	type Connection,
	type NodeProps,
	type XYPosition,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { IconPlus, IconX, IconTrash, IconCheck } from "./Icons";

import {
	type SystemAgent,
	type AgentDef,
	type FlowDef,
	ALL_TOOLS,
} from "./flows/flow-types";

// ── Agent Node Data ──

interface AgentNodeData {
	agent: AgentDef;
	isEntry: boolean;
	onSelect: (id: string) => void;
	[key: string]: unknown;
}

type AgentNode = Node<AgentNodeData>;

// ── Custom Agent Node ──

function AgentNodeComponent({ data, selected }: NodeProps<AgentNode>) {
	const { agent, isEntry } = data;
	const toolCount = agent.allowedTools.length;
	const hasConditions = (agent.transitions.conditions?.length ?? 0) > 0;
	const defaultTarget = agent.transitions.default;

	return (
		<div
			class={`canvas-agent-node${selected ? " selected" : ""}${isEntry ? " entry" : ""}`}
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

			{/* Transitions summary — shows where this node connects */}
			<div class="canvas-node-transitions">
				{defaultTarget && defaultTarget !== "END" && (
					<span class="canvas-node-transition" title="Default next agent">
						<span class="canvas-transition-arrow">→</span> {defaultTarget}
					</span>
				)}
				{defaultTarget === "END" && (
					<span
						class="canvas-node-transition canvas-node-transition-end"
						title="Flow ends here"
					>
						<span class="canvas-transition-arrow">⏹</span> END
					</span>
				)}
				{hasConditions &&
					agent.transitions.conditions!.map((c) => (
						<span
							key={c.when}
							class="canvas-node-transition canvas-node-transition-cond"
							title={`When ${c.when} → ${c.goto}`}
						>
							<span class="canvas-transition-arrow">⤷</span> {c.when} → {c.goto}
						</span>
					))}
			</div>

			{/* Default output handle */}
			<Handle
				type="source"
				position={Position.Right}
				id="default"
				className="canvas-handle canvas-handle-out"
			/>

			{/* Conditional output handles — positioned below default, with labels */}
			{hasConditions &&
				agent.transitions.conditions!.map((c, i) => (
					<Handle
						key={c.when}
						type="source"
						position={Position.Right}
						id={`cond-${c.when}`}
						className="canvas-handle canvas-handle-cond"
						style={{ top: `${65 + (i + 1) * 18}%` }}
					/>
				))}
		</div>
	);
}

// ── Manual Edge Overlay ──
// ReactFlow's built-in edge renderer doesn't work with preact/compat.
// This component draws SVG bezier curves between connected nodes using
// the ReactFlow viewport transform and node positions.

interface EdgeInfo {
	sourceId: string;
	targetId: string;
	sourceHandle: string;
	label: string;
	isLoop: boolean;
	isConditional: boolean;
}

function ManualEdgeOverlay({
	flow,
	nodes,
}: {
	flow: FlowDef;
	nodes: AgentNode[];
}) {
	const { x: vx, y: vy, zoom } = useViewport();

	// Build edge list from flow definition
	const backEdges = useMemo(() => findBackEdges(flow), [flow]);
	const edgeList: EdgeInfo[] = useMemo(() => {
		const list: EdgeInfo[] = [];
		for (const [agentId, agent] of Object.entries(flow.agents)) {
			if (agent.transitions.default && agent.transitions.default !== "END") {
				const edgeId = `${agentId}->default->${agent.transitions.default}`;
				list.push({
					sourceId: agentId,
					targetId: agent.transitions.default,
					sourceHandle: "default",
					label: backEdges.has(edgeId) ? "↩ loop" : "→ next",
					isLoop: backEdges.has(edgeId),
					isConditional: false,
				});
			}
			for (const cond of agent.transitions.conditions || []) {
				if (cond.goto !== "END") {
					list.push({
						sourceId: agentId,
						targetId: cond.goto,
						sourceHandle: `cond-${cond.when}`,
						label: `⤷ ${cond.when}`,
						isLoop: false,
						isConditional: true,
					});
				}
			}
		}
		return list;
	}, [flow, backEdges]);

	// Build node position map from current canvas state
	const nodeMap = useMemo(() => {
		const map = new Map<
			string,
			{ x: number; y: number; w: number; h: number }
		>();
		for (const n of nodes) {
			// Measure node dimensions from DOM if possible, fallback to defaults
			const el =
				document.getElementById(`rf-node-${n.id}`) ??
				document.querySelector(`[data-id="${n.id}"]`);
			const w = el?.offsetWidth ?? 260;
			const h = el?.offsetHeight ?? 160;
			map.set(n.id, { x: n.position.x, y: n.position.y, w, h });
		}
		return map;
	}, [nodes]);

	// Calculate handle Y offset for conditional handles
	function getSourceY(sourceId: string, handle: string): number {
		const node = nodeMap.get(sourceId);
		if (!node) return 0;
		if (handle === "default") return node.y + node.h * 0.35;
		// Conditional handles are below the default
		const agent = flow.agents[sourceId];
		const conds = agent?.transitions.conditions || [];
		const idx = conds.findIndex((c) => `cond-${c.when}` === handle);
		return node.y + node.h * (0.5 + (idx + 1) * 0.12);
	}

	return (
		<svg
			class="manual-edge-overlay"
			style={{
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				pointerEvents: "none",
				zIndex: 1,
				overflow: "visible",
			}}
		>
			<g transform={`translate(${vx}, ${vy}) scale(${zoom})`}>
				{edgeList.map((edge, i) => {
					const src = nodeMap.get(edge.sourceId);
					const tgt = nodeMap.get(edge.targetId);
					if (!src || !tgt) return null;

					const x1 = src.x + src.w;
					const y1 = getSourceY(edge.sourceId, edge.sourceHandle);
					const x2 = tgt.x;
					const y2 = tgt.y + tgt.h * 0.35;

					// Bezier control points
					const dx = Math.abs(x2 - x1) * 0.5;
					const cx1 = x1 + dx;
					const cx2 = x2 - dx;
					// For loops (back-edges), curve above
					const loopOffset = edge.isLoop ? -80 : 0;

					const path = edge.isLoop
						? `M ${x1} ${y1} C ${x1 + 100} ${y1 - 80}, ${x2 - 100} ${y2 - 80}, ${x2} ${y2}`
						: `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`;

					const color = edge.isLoop
						? "#f59e0b"
						: edge.isConditional
							? "#a78bfa"
							: "#6366f1";

					const midX = (x1 + x2) / 2;
					const midY = (y1 + y2) / 2 + loopOffset / 2;

					return (
						<g key={i}>
							<path
								d={path}
								fill="none"
								stroke={color}
								stroke-width="2"
								stroke-dasharray={edge.isLoop ? "8 4" : undefined}
								opacity="0.8"
							/>
							{/* Arrowhead */}
							<polygon
								points="-6,-4 0,0 -6,4"
								fill={color}
								transform={`translate(${x2}, ${y2}) rotate(0)`}
								opacity="0.8"
							/>
							{/* Label */}
							<foreignObject
								x={midX - 50}
								y={midY - 12}
								width="100"
								height="24"
								style={{ overflow: "visible" }}
							>
								<div
									className={`canvas-edge-label${edge.isLoop ? " canvas-edge-loop" : ""}${edge.isConditional ? " canvas-edge-cond" : ""}`}
									style={{
										textAlign: "center",
										whiteSpace: "nowrap",
										fontSize: "10px",
									}}
								>
									{edge.label}
								</div>
							</foreignObject>
						</g>
					);
				})}
			</g>
		</svg>
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

/** Detect back-edges (loops) via DFS — edges where target is an ancestor of source */
function findBackEdges(flow: FlowDef): Set<string> {
	const backEdges = new Set<string>();
	const WHITE = 0,
		GRAY = 1,
		BLACK = 2;
	const color: Record<string, number> = {};
	for (const id of Object.keys(flow.agents)) color[id] = WHITE;

	function dfs(id: string) {
		color[id] = GRAY;
		const agent = flow.agents[id];
		if (!agent) return;
		const targets: Array<{ target: string; handle: string }> = [];
		if (agent.transitions.default && agent.transitions.default !== "END") {
			targets.push({ target: agent.transitions.default, handle: "default" });
		}
		for (const cond of agent.transitions.conditions || []) {
			if (cond.goto !== "END")
				targets.push({ target: cond.goto, handle: `cond-${cond.when}` });
		}
		for (const { target, handle } of targets) {
			if (color[target] === GRAY) {
				backEdges.add(`${id}->${handle}->${target}`);
			} else if (color[target] === WHITE) {
				dfs(target);
			}
		}
		color[id] = BLACK;
	}

	dfs(flow.entryAgentId);
	// Handle disconnected nodes
	for (const id of Object.keys(flow.agents)) {
		if (color[id] === WHITE) dfs(id);
	}
	return backEdges;
}

function flowToGraph(
	flow: FlowDef,
	onSelect: (id: string) => void,
): { nodes: AgentNode[]; edges: Edge[] } {
	const positions = autoLayout(flow);
	const backEdges = findBackEdges(flow);
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
		});

		if (agent.transitions.default && agent.transitions.default !== "END") {
			const edgeId = `${agentId}->default->${agent.transitions.default}`;
			const isLoop = backEdges.has(edgeId);
			edges.push({
				id: edgeId,
				source: agentId,
				target: agent.transitions.default,
				sourceHandle: "default",
				type: "default",
				label: isLoop ? "↩ loop" : "→ next",
				style: { stroke: isLoop ? "#f59e0b" : "#6366f1", strokeWidth: 2 },
				animated: isLoop,
				markerEnd: {
					type: MarkerType.ArrowClosed,
					width: 16,
					height: 16,
					color: isLoop ? "#f59e0b" : "#6366f1",
				},
			});
		}

		if (agent.transitions.conditions) {
			for (const cond of agent.transitions.conditions) {
				if (cond.goto !== "END") {
					const edgeId = `${agentId}->cond-${cond.when}->${cond.goto}`;
					edges.push({
						id: edgeId,
						source: agentId,
						target: cond.goto,
						sourceHandle: `cond-${cond.when}`,
						type: "default",
						label: `⤷ ${cond.when}`,
						style: { stroke: "#a78bfa", strokeWidth: 2 },
						animated: true,
						markerEnd: {
							type: MarkerType.ArrowClosed,
							width: 16,
							height: 16,
							color: "#a78bfa",
						},
					});
				}
			}
		}
	}

	return { nodes, edges };
}

// ── Node/edge type registries (stable reference) ──

const nodeTypes = { agentNode: AgentNodeComponent };

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

	const onSelect = useCallback((id: string) => {
		setSelectedAgentId((prev) => (prev === id ? null : id));
	}, []);

	// Build graph representation — do NOT depend on selectedAgentId to avoid
	// full graph rebuild + fitView reset on every node click
	const graph = useMemo(() => flowToGraph(flow, onSelect), [flow, onSelect]);

	const [nodes, setNodes] = useState<AgentNode[]>(graph.nodes);
	const [edges, setEdges] = useState<Edge[]>(graph.edges);

	// Sync graph when flow data changes (from property panel edits)
	// Preserve node positions from current canvas state
	useEffect(() => {
		setNodes((prev) => {
			const posMap = new Map(prev.map((n) => [n.id, n.position]));
			return graph.nodes.map((n) => ({
				...n,
				position: posMap.get(n.id) ?? n.position,
			}));
		});
		setEdges(graph.edges);
	}, [graph]);

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
			// Guard: prevent self-loops (would cause infinite loop in runtime)
			if (conn.source === conn.target) return;
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

	// Clear ReactFlow's internal node selection state
	const deselectAllNodes = useCallback(() => {
		setNodes((nds) =>
			nds.map((n) => (n.selected ? { ...n, selected: false } : n)),
		);
	}, []);

	const clearSelection = useCallback(() => {
		setSelectedAgentId(null);
		deselectAllNodes();
	}, [deselectAllNodes]);

	const onNodeClick = useCallback((_: MouseEvent, node: AgentNode) => {
		setSelectedAgentId((prev) => (prev === node.id ? null : node.id));
	}, []);

	const onPaneClick = useCallback(() => clearSelection(), [clearSelection]);

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
			// Filter out deletions that would remove all agents
			const agentCount = Object.keys(flow.agents).length;
			const removing = new Set(
				deleted.map((n) => n.id).filter((id) => flow.agents[id]),
			);
			if (agentCount - removing.size < 1) {
				// Restore nodes to prevent canvas/data desync
				setNodes((prev) => prev);
				return;
			}

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
			if (selectedAgentId && removing.has(selectedAgentId)) clearSelection();
		},
		[flow, onChange, selectedAgentId, clearSelection],
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
			? `${sa.id}-${crypto.randomUUID().slice(0, 8)}`
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
		clearSelection();
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
						isValidConnection={(conn: Connection) =>
							conn.source !== conn.target
						}
						nodeTypes={nodeTypes}
						fitView
						snapToGrid
						snapGrid={[20, 20]}
						deleteKeyCode="Delete"
						defaultEdgeOptions={{
							type: "default",
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
						<ManualEdgeOverlay flow={flow} nodes={nodes} />
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
							<button class="btn-icon" onClick={clearSelection}>
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
