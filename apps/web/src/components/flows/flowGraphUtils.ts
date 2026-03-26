/**
 * flowGraphUtils — Pure utility functions for flow graph layout and conversion.
 *
 * No JSX, no React — just data transformation from FlowDef to graph structures.
 */

import {
	MarkerType,
	type Node,
	type Edge,
	type XYPosition,
} from "@xyflow/react";
import type { AgentDef, FlowDef } from "./flow-types";

// ── Agent Node Data (shared type for graph nodes) ──

export interface AgentNodeData {
	agent: AgentDef;
	isEntry: boolean;
	onSelect: (id: string) => void;
	[key: string]: unknown;
}

export type AgentNode = Node<AgentNodeData>;

// ── Layout: Auto-position nodes ──

export function autoLayout(flow: FlowDef): Record<string, XYPosition> {
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

// ── Detect back-edges (loops) via DFS ──

/** Detect back-edges (loops) via DFS — edges where target is an ancestor of source */
export function findBackEdges(flow: FlowDef): Set<string> {
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

// ── Convert FlowDef → ReactFlow nodes/edges ──

export function flowToGraph(
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
