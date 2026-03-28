/**
 * Teams API client — frontend service for team template CRUD and execution.
 */

import { apiFetch } from "../api";

// ── Types ──

export interface TeamAgentDef {
	id: string;
	name: string;
	role: string;
	systemPrompt: string;
	allowedTools: string[];
}

export interface TeamTemplateDef {
	id: string;
	name: string;
	description: string;
	version: string;
	isTemplate: boolean;
	createdAt: string;
	updatedAt: string;
	agents: Record<string, TeamAgentDef>;
}

export interface TeamExecutionDef {
	id: string;
	templateId: string | null;
	templateName: string;
	status: string;
	tmuxSession: string;
	leaderSessionId: string | null;
	startedAt: string;
	completedAt: string | null;
}

// ── Cache ──

let cachedTemplates: TeamTemplateDef[] = [];
let cacheLoaded = false;

export function getCachedTeamTemplates(): TeamTemplateDef[] {
	return cachedTemplates;
}

export function isTeamCacheLoaded(): boolean {
	return cacheLoaded;
}

// ── API ──

export async function loadTeamTemplates(): Promise<TeamTemplateDef[]> {
	const res = await apiFetch("/api/teams");
	const data = (await res.json()) as { templates: TeamTemplateDef[] };
	cachedTemplates = data.templates || [];
	cacheLoaded = true;
	return cachedTemplates;
}

export async function getTeamTemplate(
	id: string,
): Promise<TeamTemplateDef | null> {
	const res = await apiFetch(`/api/teams/${id}`);
	if (!res.ok) return null;
	return (await res.json()) as TeamTemplateDef;
}

export async function saveTeamTemplate(
	template: Partial<TeamTemplateDef> & {
		name: string;
		agents: Record<string, TeamAgentDef>;
	},
): Promise<TeamTemplateDef> {
	if (template.id) {
		const res = await apiFetch(`/api/teams/${template.id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(template),
		});
		const saved = (await res.json()) as TeamTemplateDef;
		cachedTemplates = cachedTemplates.map((t) =>
			t.id === saved.id ? saved : t,
		);
		return saved;
	}
	const res = await apiFetch("/api/teams", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(template),
	});
	const saved = (await res.json()) as TeamTemplateDef;
	cachedTemplates = [...cachedTemplates, saved];
	return saved;
}

export async function deleteTeamTemplate(id: string): Promise<boolean> {
	const res = await apiFetch(`/api/teams/${id}`, { method: "DELETE" });
	if (res.ok) {
		cachedTemplates = cachedTemplates.filter((t) => t.id !== id);
	}
	return res.ok;
}

export async function launchTeam(
	templateId: string,
	input?: string,
	cwd?: string,
): Promise<{ executionId: string; leaderSessionId: string }> {
	const res = await apiFetch(`/api/teams/${templateId}/launch`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ input, cwd }),
	});
	return (await res.json()) as {
		executionId: string;
		leaderSessionId: string;
	};
}

export async function stopTeamExecution(executionId: string): Promise<boolean> {
	const res = await apiFetch(`/api/teams/executions/${executionId}/stop`, {
		method: "POST",
	});
	return res.ok;
}

export async function loadTeamExecutions(): Promise<TeamExecutionDef[]> {
	const res = await apiFetch("/api/teams/executions/list");
	const data = (await res.json()) as { executions: TeamExecutionDef[] };
	return data.executions || [];
}
