// ── Shared types and utilities for the Orchestrator (Flows) feature ──

export interface SystemAgent {
	id: string;
	name: string;
	description: string;
	tools: string[];
}

export interface AgentDef {
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

export interface FlowDef {
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

export interface FlowExecution {
	id: string;
	flowId: string;
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	currentAgentId: string | null;
	startedAt: string;
	completedAt: string | null;
	initialInput: string;
	agentResults: Record<
		string,
		{ agentId: string; status: string; output: string }
	>;
}

export const ALL_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Glob",
	"Grep",
	"WebSearch",
	"WebFetch",
];

/** Walk agent graph in BFS order starting from entryAgentId */
export function walkAgents(flow: FlowDef): AgentDef[] {
	const ordered: AgentDef[] = [];
	const visited = new Set<string>();
	const queue: string[] = [flow.entryAgentId];
	while (queue.length > 0) {
		const cursor = queue.shift();
		if (!cursor || visited.has(cursor) || !flow.agents[cursor]) continue;
		ordered.push(flow.agents[cursor]);
		visited.add(cursor);
		const next = flow.agents[cursor].transitions.default;
		if (typeof next === "string" && next !== "END") {
			queue.push(next);
		}
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
