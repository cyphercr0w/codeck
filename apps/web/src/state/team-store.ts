/**
 * Team Store — Preact signals for Agent Teams state management.
 *
 * Tracks active team executions, agent sessions, and selected agent.
 * Used by TeamExecutionViewer and ws.ts event handlers.
 */

import { signal } from "@preact/signals";

// ── Types ──

export interface TeamAgent {
	id: string;
	name: string;
	role: string;
	sessionId: string;
	tmuxPane: string;
	status: "pending" | "detected" | "running" | "idle" | "shutdown";
}

export interface ActiveTeam {
	executionId: string;
	templateName: string;
	leaderSessionId: string;
	agents: TeamAgent[];
	status: "launching" | "running" | "completed" | "failed" | "cancelled";
	startedAt: number;
}

// ── Signals ──

export const activeTeam = signal<ActiveTeam | null>(null);
export const selectedAgentSessionId = signal<string | null>(null);

// ── Event Handlers (called from ws.ts) ──

export function onTeamLaunched(data: {
	executionId: string;
	templateName: string;
	leaderSessionId: string;
	agents: Array<{ id: string; name: string; role: string }>;
}): void {
	activeTeam.value = {
		executionId: data.executionId,
		templateName: data.templateName,
		leaderSessionId: data.leaderSessionId,
		agents: data.agents.map((a) => ({
			...a,
			sessionId: "",
			tmuxPane: "",
			status: "pending" as const,
		})),
		status: "running",
		startedAt: Date.now(),
	};
	// Select leader by default
	selectedAgentSessionId.value = data.leaderSessionId;
}

export function onTeamAgentDetected(data: {
	executionId: string;
	agentId: string;
	name: string;
	role: string;
	sessionId: string;
	tmuxPane: string;
}): void {
	const team = activeTeam.value;
	if (!team || team.executionId !== data.executionId) return;

	// Update existing agent or add new one
	const existing = team.agents.find((a) => a.id === data.agentId);
	if (existing) {
		activeTeam.value = {
			...team,
			agents: team.agents.map((a) =>
				a.id === data.agentId
					? {
							...a,
							sessionId: data.sessionId,
							tmuxPane: data.tmuxPane,
							status: "detected" as const,
						}
					: a,
			),
		};
	} else {
		activeTeam.value = {
			...team,
			agents: [
				...team.agents,
				{
					id: data.agentId,
					name: data.name,
					role: data.role,
					sessionId: data.sessionId,
					tmuxPane: data.tmuxPane,
					status: "detected",
				},
			],
		};
	}
}

export function onTeamStopped(data: {
	executionId: string;
	status: string;
}): void {
	const team = activeTeam.value;
	if (!team || team.executionId !== data.executionId) return;

	activeTeam.value = {
		...team,
		status: (data.status as ActiveTeam["status"]) || "completed",
	};
}

export function selectTeamAgent(sessionId: string): void {
	selectedAgentSessionId.value = sessionId;
}

export function clearActiveTeam(): void {
	activeTeam.value = null;
	selectedAgentSessionId.value = null;
}
