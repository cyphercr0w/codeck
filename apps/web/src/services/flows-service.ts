import { apiFetch } from "../api";
import { showToast } from "../state/store";
import {
	walkAgents,
	type FlowDef,
	type FlowExecution,
	type SystemAgent,
} from "../components/flows/flow-types";
import { startFlowInChat } from "../state/chat-store";

// ── Module-level cache — persists across tab switches (component unmount/remount) ──

let cachedFlows: FlowDef[] = [];
let cachedExecutions: FlowExecution[] = [];
let cachedSystemAgents: SystemAgent[] = [];
let cacheLoaded = false;

export function getCachedFlows(): FlowDef[] {
	return cachedFlows;
}

export function getCachedExecutions(): FlowExecution[] {
	return cachedExecutions;
}

export function getCachedSystemAgents(): SystemAgent[] {
	return cachedSystemAgents;
}

export function isCacheLoaded(): boolean {
	return cacheLoaded;
}

export function markCacheLoaded(): void {
	cacheLoaded = true;
}

// ── API functions ──

export async function loadFlows(): Promise<FlowDef[]> {
	try {
		const r = await apiFetch("/api/flows");
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const d = await r.json();
		const list = d.flows || [];
		cachedFlows = list;
		return list;
	} catch {
		return cachedFlows;
	}
}

export async function loadExecutions(): Promise<FlowExecution[]> {
	try {
		const r = await apiFetch("/api/flows/executions/list");
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const d = await r.json();
		const list = d.executions || [];
		cachedExecutions = list;
		return list;
	} catch {
		return cachedExecutions;
	}
}

export async function loadSystemAgents(): Promise<SystemAgent[]> {
	try {
		const r = await apiFetch("/api/flows/available-agents");
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const d = await r.json();
		cachedSystemAgents = d.agents || [];
		return cachedSystemAgents;
	} catch {
		return cachedSystemAgents;
	}
}

export async function deleteFlow(id: string): Promise<boolean> {
	try {
		await apiFetch(`/api/flows/${id}`, { method: "DELETE" });
		showToast("Flow deleted", "info");
		return true;
	} catch {
		showToast("Failed to delete flow", "error");
		return false;
	}
}

export async function executeFlow(
	flowId: string,
	input: string,
	flows: FlowDef[],
): Promise<string | null> {
	const flow = flows.find((f) => f.id === flowId);
	if (!flow) return null;
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
			return data.executionId;
		}
		return null;
	} catch {
		showToast("Failed to start flow", "error");
		return null;
	}
}

export async function saveFlow(flow: FlowDef): Promise<boolean> {
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
		return true;
	} catch {
		showToast("Failed to save flow", "error");
		return false;
	}
}

export function createNewFlow(): FlowDef {
	const now = new Date().toISOString();
	return {
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
	};
}
