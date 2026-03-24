/**
 * Agent Flows — Type definitions
 *
 * A flow is a directed graph of agents where each agent's output
 * becomes the next agent's input. Supports conditional transitions
 * and loops (e.g., reviewer → implementer loop).
 */

// ── Agent Definition ──

export interface AgentDefinition {
	id: string;
	name: string;
	role: string;
	systemPrompt: string;
	inputTemplate: string; // Supports {{prev_output}} and {{flow_context}}
	allowedTools: string[];
	mcpServers: string[];
	maxTurns: number;
	maxVisits?: number; // Max times this agent can be visited before failing (default: 10)
	timeoutMs: number;
	outputParser: "raw" | "structured";
	structuredOutputSchema?: {
		decisionField: string;
		decisionsEnum: string[];
	};
	transitions: {
		default?: string | "END";
		conditions?: Array<{
			when: string;
			goto: string | "END";
		}>;
	};
}

// ── Flow Definition ──

export interface FlowDefinition {
	id: string;
	name: string;
	description: string;
	version: string;
	isTemplate: boolean;
	createdAt: string;
	updatedAt: string;
	entryAgentId: string;
	agents: Record<string, AgentDefinition>;
}

// ── Flow Execution ──

export type FlowStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type AgentStatus = "pending" | "running" | "completed" | "failed";

export interface AgentResult {
	agentId: string;
	status: AgentStatus;
	startedAt: string;
	completedAt: string | null;
	output: string;
	structuredDecision?: string;
	tokenUsage?: { input: number; output: number };
}

export interface FlowExecution {
	id: string;
	flowId: string;
	flowVersion: string;
	status: FlowStatus;
	currentAgentId: string | null;
	loopCount: number;
	maxLoops: number;
	startedAt: string;
	completedAt: string | null;
	initialInput: string;
	agentResults: Record<string, AgentResult>;
}

// ── WebSocket Events ──

export interface FlowExecutionUpdateEvent {
	type: "flow:execution:update";
	data: FlowExecution;
}

export interface FlowAgentOutputEvent {
	type: "flow:agent:output";
	data: { executionId: string; agentId: string; chunk: string };
}

export interface FlowAgentCompleteEvent {
	type: "flow:agent:complete";
	data: { executionId: string; agentId: string; result: AgentResult };
}

export interface FlowExecutionCompleteEvent {
	type: "flow:execution:complete";
	data: FlowExecution;
}
