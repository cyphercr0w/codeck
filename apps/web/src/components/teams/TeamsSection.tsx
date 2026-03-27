/**
 * TeamsSection — Team template list, creation, and launch UI.
 *
 * Main orchestration view for Agent Teams — template list, creation, and launch.
 * Provides CRUD for team templates and launch functionality.
 */

import { useState, useEffect } from "preact/hooks";
import { activeTeam } from "../../state/team-store";
import {
	loadTeamTemplates,
	saveTeamTemplate,
	deleteTeamTemplate,
	launchTeam,
	getCachedTeamTemplates,
	isTeamCacheLoaded,
	type TeamTemplateDef,
	type TeamAgentDef,
} from "../../services/teams-service";
import { showToast } from "../../state/store";
import TeamExecutionViewer from "./TeamExecutionViewer";
import "../../styles/team-viewer.css";

export function TeamsSection() {
	const [templates, setTemplates] = useState<TeamTemplateDef[]>(
		getCachedTeamTemplates(),
	);
	const [view, setView] = useState<"list" | "edit" | "active">("list");
	const [editingTemplate, setEditingTemplate] =
		useState<Partial<TeamTemplateDef> | null>(null);
	const [launchInputs, setLaunchInputs] = useState<Record<string, string>>({});
	const [launching, setLaunching] = useState(false);

	const team = activeTeam.value;

	useEffect(() => {
		if (!isTeamCacheLoaded()) {
			loadTeamTemplates()
				.then(setTemplates)
				.catch(() => showToast("Failed to load team templates"));
		}
		// If team is active, show it
		if (team) setView("active");
	}, []);

	useEffect(() => {
		if (team && view !== "active") setView("active");
		if (!team && view === "active") setView("list");
	}, [team?.executionId]);

	async function handleLaunch(templateId: string) {
		setLaunching(true);
		try {
			await launchTeam(templateId, launchInputs[templateId] || undefined);
			setLaunchInputs((prev) => ({ ...prev, [templateId]: "" }));
			setView("active");
		} catch (e) {
			showToast(`Launch failed: ${(e as Error).message}`);
		} finally {
			setLaunching(false);
		}
	}

	async function handleSave() {
		if (!editingTemplate?.name) return;
		try {
			const saved = await saveTeamTemplate(editingTemplate as TeamTemplateDef);
			setTemplates(
				templates.some((t) => t.id === saved.id)
					? templates.map((t) => (t.id === saved.id ? saved : t))
					: [...templates, saved],
			);
			setView("list");
			setEditingTemplate(null);
			showToast("Template saved");
		} catch (e) {
			showToast(`Save failed: ${(e as Error).message}`);
		}
	}

	async function handleDelete(id: string) {
		try {
			await deleteTeamTemplate(id);
			setTemplates(templates.filter((t) => t.id !== id));
		} catch {
			showToast("Failed to delete template");
		}
	}

	// ── Active team ──
	if (view === "active" && team) {
		return <TeamExecutionViewer />;
	}

	// ── Edit template ──
	if (view === "edit" && editingTemplate) {
		return (
			<div class="teams-edit">
				<div class="teams-edit-header">
					<button class="team-back-btn" onClick={() => setView("list")}>
						← Back
					</button>
					<h3>{editingTemplate.id ? "Edit Team" : "New Team"}</h3>
				</div>
				<div class="teams-edit-form">
					<label>
						Name
						<input
							type="text"
							value={editingTemplate.name || ""}
							onInput={(e) =>
								setEditingTemplate({
									...editingTemplate,
									name: (e.target as HTMLInputElement).value,
								})
							}
						/>
					</label>
					<label>
						Description
						<input
							type="text"
							value={editingTemplate.description || ""}
							onInput={(e) =>
								setEditingTemplate({
									...editingTemplate,
									description: (e.target as HTMLInputElement).value,
								})
							}
						/>
					</label>

					<h4>Agents ({Object.keys(editingTemplate.agents || {}).length})</h4>
					{Object.entries(editingTemplate.agents || {}).map(([id, agent]) => (
						<div key={id} class="teams-agent-card">
							<div class="teams-agent-header">
								<strong>{(agent as TeamAgentDef).name}</strong>
								<span class="teams-agent-role">
									{(agent as TeamAgentDef).role}
								</span>
							</div>
							<textarea
								rows={3}
								value={(agent as TeamAgentDef).systemPrompt}
								onInput={(e) => {
									const agents = { ...editingTemplate.agents };
									agents[id] = {
										...(agents[id] as TeamAgentDef),
										systemPrompt: (e.target as HTMLTextAreaElement).value,
									};
									setEditingTemplate({ ...editingTemplate, agents });
								}}
							/>
						</div>
					))}

					<div class="teams-edit-actions">
						<button class="team-save-btn" onClick={handleSave}>
							Save
						</button>
						<button class="team-cancel-btn" onClick={() => setView("list")}>
							Cancel
						</button>
					</div>
				</div>
			</div>
		);
	}

	// ── List templates ──
	return (
		<div class="teams-list">
			<div class="teams-list-header">
				<h3>Agent Teams</h3>
				<button
					class="team-new-btn"
					onClick={() => {
						setEditingTemplate({
							name: "",
							description: "",
							agents: {
								agent1: {
									id: "agent1",
									name: "Agent 1",
									role: "Developer",
									systemPrompt: "",
									allowedTools: [
										"Read",
										"Edit",
										"Write",
										"Bash",
										"Glob",
										"Grep",
									],
								},
							},
						});
						setView("edit");
					}}
				>
					+ New Team
				</button>
			</div>

			{templates.length === 0 ? (
				<div class="teams-empty">
					No team templates yet. Create one to get started.
				</div>
			) : (
				<div class="teams-grid">
					{templates.map((t) => (
						<div key={t.id} class="teams-card">
							<div class="teams-card-header">
								<span class="teams-card-name">{t.name}</span>
								<span class="teams-card-agents">
									{Object.keys(t.agents).length} agents
								</span>
							</div>
							{t.description && <p class="teams-card-desc">{t.description}</p>}
							<div class="teams-card-agent-list">
								{Object.values(t.agents).map((a) => (
									<span key={a.id} class="teams-card-agent-tag">
										{a.name}
									</span>
								))}
							</div>
							<div class="teams-card-actions">
								<input
									type="text"
									class="teams-launch-input"
									placeholder="Task description..."
									value={launchInputs[t.id] || ""}
									onInput={(e) =>
										setLaunchInputs((prev) => ({
											...prev,
											[t.id]: (e.target as HTMLInputElement).value,
										}))
									}
								/>
								<button
									class="team-launch-btn"
									disabled={launching}
									onClick={() => handleLaunch(t.id)}
								>
									{launching ? "Launching..." : "Launch"}
								</button>
								<button
									class="team-edit-btn"
									onClick={() => {
										setEditingTemplate(t);
										setView("edit");
									}}
								>
									Edit
								</button>
								{!t.isTemplate && (
									<button
										class="team-delete-btn"
										onClick={() => handleDelete(t.id)}
									>
										Delete
									</button>
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
