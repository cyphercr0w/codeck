/**
 * Agent Teams — Type definitions
 *
 * A team is a parallel group of agents that collaborate via
 * Claude Code Agent Teams (native coordination). Unlike flows,
 * teams have no sequential transitions — all agents work in parallel.
 */

// ── Team Agent Definition ──

export interface TeamAgentDefinition {
	id: string;
	name: string;
	role: string;
	systemPrompt: string;
	allowedTools: string[];
}

// ── Team Template ──

export interface TeamTemplate {
	id: string;
	name: string;
	description: string;
	version: string;
	isTemplate: boolean;
	createdAt: string;
	updatedAt: string;
	agents: Record<string, TeamAgentDefinition>;
}

// ── Team Execution ──

export type TeamStatus =
	| "pending"
	| "launching"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type TeamAgentStatus =
	| "pending"
	| "detected"
	| "running"
	| "idle"
	| "shutdown";

export interface TeamAgentState {
	agentId: string;
	name: string;
	role: string;
	sessionId: string | null;
	tmuxPane: string | null;
	status: TeamAgentStatus;
	detectedAt: string | null;
}

export interface TeamExecution {
	id: string;
	templateId: string | null;
	templateName: string;
	status: TeamStatus;
	tmuxSession: string;
	agents: Record<string, TeamAgentState>;
	leaderSessionId: string | null;
	startedAt: string;
	completedAt: string | null;
	initialPrompt: string;
}

// ── WebSocket Events ──

export interface TeamLaunchedEvent {
	type: "team:launched";
	data: {
		executionId: string;
		templateName: string;
		agents: Array<{ id: string; name: string; role: string }>;
		leaderSessionId: string;
	};
}

export interface TeamAgentDetectedEvent {
	type: "team:agent:detected";
	data: {
		executionId: string;
		agentId: string;
		name: string;
		role: string;
		sessionId: string;
		tmuxPane: string;
	};
}

export interface TeamStoppedEvent {
	type: "team:stopped";
	data: {
		executionId: string;
		status: TeamStatus;
	};
}
