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
/** Controls team preview panel visibility in terminal section */
export const teamPreviewMode = signal<"hidden" | "split" | "full">("hidden");

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
	selectedAgentSessionId.value = data.leaderSessionId;
	// Auto-show preview panel in terminal section
	teamPreviewMode.value = "split";
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

export function onTeamAgentShutdown(data: {
	executionId: string;
	agentId: string;
}): void {
	const team = activeTeam.value;
	if (!team || team.executionId !== data.executionId) return;

	activeTeam.value = {
		...team,
		agents: team.agents.map((a) =>
			a.id === data.agentId ? { ...a, status: "shutdown" as const } : a,
		),
	};
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
	teamPreviewMode.value = "hidden";
}

/** Reconnect to an active execution found via API (e.g. after page refresh). */
export function reconnectTeam(exec: {
	id: string;
	templateName: string;
	status: string;
	leaderSessionId: string | null;
	agents: Record<
		string,
		{
			agentId: string;
			name: string;
			role: string;
			sessionId: string | null;
			status: string;
		}
	>;
}): void {
	activeTeam.value = {
		executionId: exec.id,
		templateName: exec.templateName,
		leaderSessionId: exec.leaderSessionId || "",
		agents: Object.values(exec.agents).map((a) => ({
			id: a.agentId,
			name: a.name,
			role: a.role,
			sessionId: a.sessionId || "",
			tmuxPane: "",
			status: (a.status as TeamAgent["status"]) || "pending",
		})),
		status: (exec.status as ActiveTeam["status"]) || "running",
		startedAt: Date.now(),
	};
	if (exec.leaderSessionId) {
		selectedAgentSessionId.value = exec.leaderSessionId;
	}
	teamPreviewMode.value = "split";
}
