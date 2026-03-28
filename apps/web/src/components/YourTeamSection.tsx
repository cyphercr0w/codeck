import { useState, useEffect } from "preact/hooks";
import { apiFetch } from "../api";
import { IconPlus, IconChevronLeft, IconTrash, IconBot, IconX } from "./Icons";
import { ConfirmModal } from "./ConfirmModal";
import "../styles/your-team.css";

// ── Types ──

interface AgentDef {
	name: string;
	description: string;
	model: "sonnet" | "opus" | "haiku" | string;
	tools: string[];
	prompt: string;
}

// ── Helpers ──

const MODEL_LABELS: Record<string, string> = {
	sonnet: "Sonnet",
	opus: "Opus",
	haiku: "Haiku",
};

const MODEL_BADGE_CLASS: Record<string, string> = {
	sonnet: "badge badge-model-sonnet",
	opus: "badge badge-model-opus",
	haiku: "badge badge-model-haiku",
};

function modelBadgeClass(model: string): string {
	return MODEL_BADGE_CLASS[model] ?? "badge badge-muted";
}

const COMMON_TOOLS = [
	"Read",
	"Edit",
	"Write",
	"Bash",
	"Grep",
	"Glob",
	"WebFetch",
	"WebSearch",
	"Agent",
	"SendMessage",
	"TaskCreate",
	"TaskUpdate",
	"TaskList",
];

// ── Agent Card ──

function AgentDefCard({
	agent,
	onSelect,
	onDelete,
}: {
	agent: AgentDef;
	onSelect: () => void;
	onDelete: () => void;
}) {
	const [confirmOpen, setConfirmOpen] = useState(false);

	return (
		<>
			<div class="yt-card" onClick={onSelect}>
				<div class="yt-card-header">
					<span class="yt-card-name">{agent.name}</span>
					<span class={modelBadgeClass(agent.model)}>
						{MODEL_LABELS[agent.model] ?? agent.model}
					</span>
				</div>
				<p class={`yt-card-desc${!agent.description ? " yt-count" : ""}`}>
					{agent.description || "No description"}
				</p>
				<div class="yt-card-meta">
					<span class="yt-count">
						{agent.tools.length} {agent.tools.length === 1 ? "tool" : "tools"}
					</span>
				</div>
				<div class="yt-card-actions" onClick={(e) => e.stopPropagation()}>
					<button
						class="btn btn-xs btn-ghost danger"
						onClick={() => setConfirmOpen(true)}
					>
						<IconTrash size={11} /> Delete
					</button>
				</div>
			</div>
			<ConfirmModal
				visible={confirmOpen}
				title={`Delete "${agent.name}"`}
				message="This will permanently remove this agent definition. This action cannot be undone."
				confirmLabel="Delete"
				onConfirm={() => {
					setConfirmOpen(false);
					onDelete();
				}}
				onCancel={() => setConfirmOpen(false)}
			/>
		</>
	);
}

// ── Tools Editor ──

function ToolsEditor({
	tools,
	onChange,
}: {
	tools: string[];
	onChange: (tools: string[]) => void;
}) {
	const [customInput, setCustomInput] = useState("");
	const customTools = tools.filter((t) => !COMMON_TOOLS.includes(t));

	function toggleCommon(tool: string) {
		if (tools.includes(tool)) {
			onChange(tools.filter((t) => t !== tool));
		} else {
			onChange([...tools, tool]);
		}
	}

	function addCustom() {
		const t = customInput.trim();
		if (t && !tools.includes(t)) {
			onChange([...tools, t]);
		}
		setCustomInput("");
	}

	function removeCustom(t: string) {
		onChange(tools.filter((x) => x !== t));
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === "Enter") {
			e.preventDefault();
			addCustom();
		}
	}

	return (
		<div>
			<div class="yt-tools-checklist">
				{COMMON_TOOLS.map((tool) => {
					const id = `tool-cb-${tool}`;
					return (
						<div key={tool} class="yt-tools-check-item">
							<input
								type="checkbox"
								id={id}
								checked={tools.includes(tool)}
								onChange={() => toggleCommon(tool)}
							/>
							<label for={id}>{tool}</label>
						</div>
					);
				})}
			</div>
			<div class="yt-tools-custom">
				{customTools.length > 0 && (
					<div class="yt-tools-list">
						{customTools.map((t) => (
							<span key={t} class="yt-tool-tag">
								{t}
								<button
									class="yt-tool-tag-remove"
									type="button"
									onClick={() => removeCustom(t)}
									title={`Remove ${t}`}
								>
									<IconX size={10} />
								</button>
							</span>
						))}
					</div>
				)}
				<div class="yt-tool-add-row">
					<input
						type="text"
						placeholder="Add custom tool (e.g. mcp__memory__search_nodes)"
						value={customInput}
						onInput={(e) =>
							setCustomInput((e.target as HTMLInputElement).value)
						}
						onKeyDown={handleKeyDown as any}
					/>
					<button
						type="button"
						class="btn btn-xs btn-secondary"
						onClick={addCustom}
						disabled={!customInput.trim()}
					>
						<IconPlus size={12} /> Add
					</button>
				</div>
			</div>
		</div>
	);
}

// ── Edit / Create View ──

function AgentDefEditor({
	initial,
	isNew,
	onBack,
	onSaved,
}: {
	initial: AgentDef | null;
	isNew: boolean;
	onBack: () => void;
	onSaved: () => void;
}) {
	const [name, setName] = useState(initial?.name ?? "");
	const [description, setDescription] = useState(initial?.description ?? "");
	const [model, setModel] = useState<string>(initial?.model ?? "sonnet");
	const [tools, setTools] = useState<string[]>(initial?.tools ?? []);
	const [prompt, setPrompt] = useState(initial?.prompt ?? "");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	async function handleSave(e: Event) {
		e.preventDefault();
		const agentName = isNew ? name.trim() : (initial?.name ?? "");
		if (!agentName) {
			setError("Name is required");
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const content = `---\nname: ${agentName}\ndescription: ${description}\nmodel: ${model}\ntools: ${JSON.stringify(tools)}\n---\n\n${prompt}`;
			const res = await apiFetch(
				`/api/your-team/${encodeURIComponent(agentName)}`,
				{
					method: "PUT",
					body: JSON.stringify({ content }),
				},
			);
			const data = await res.json();
			if (data.error) {
				setError(data.error);
				setSaving(false);
				return;
			}
			setSaved(true);
			setTimeout(() => setSaved(false), 2000);
			onSaved();
		} catch {
			setError("Failed to save agent");
		}
		setSaving(false);
	}

	return (
		<div class="yt-edit">
			<div class="yt-edit-header">
				<button class="btn btn-xs btn-ghost" onClick={onBack} type="button">
					<IconChevronLeft size={14} /> Back
				</button>
				<div class="yt-edit-title">{isNew ? "New Agent" : initial?.name}</div>
				{saved && (
					<span class="yt-count" style="color: var(--success)">
						Saved!
					</span>
				)}
			</div>

			<form onSubmit={handleSave as any}>
				<div class="yt-section">
					<div class="yt-section-heading">Identity</div>
					{isNew && (
						<div class="form-group">
							<label class="form-label">Name</label>
							<input
								type="text"
								placeholder="agent-name"
								value={name}
								onInput={(e) => setName((e.target as HTMLInputElement).value)}
								required
							/>
						</div>
					)}
					<div class="form-group">
						<label class="form-label">Description</label>
						<textarea
							placeholder="What does this agent do?"
							value={description}
							rows={2}
							onInput={(e) =>
								setDescription((e.target as HTMLTextAreaElement).value)
							}
						/>
					</div>
				</div>

				<div class="yt-section">
					<div class="yt-section-heading">Configuration</div>
					<div class="form-group">
						<label class="form-label">Model</label>
						<div class="yt-model-pills">
							{(["sonnet", "opus", "haiku"] as const).map((m) => (
								<button
									key={m}
									type="button"
									class={`yt-model-pill${model === m ? ` active ${m}` : ""}`}
									data-model={m}
									onClick={() => setModel(m)}
								>
									{MODEL_LABELS[m]}
								</button>
							))}
						</div>
					</div>
					<div class="form-group">
						<label class="form-label">
							Tools <span class="yt-count">({tools.length})</span>
						</label>
						<ToolsEditor tools={tools} onChange={setTools} />
					</div>
				</div>

				<div class="yt-section">
					<div class="yt-section-heading">Prompt</div>
					<div class="form-group">
						<label class="form-label">System Prompt</label>
						<textarea
							class="yt-prompt-textarea"
							placeholder="You are a helpful agent..."
							value={prompt}
							onInput={(e) =>
								setPrompt((e.target as HTMLTextAreaElement).value)
							}
						/>
					</div>
				</div>

				{error && <div class="yt-error">{error}</div>}

				<div class="yt-actions">
					<button
						type="submit"
						class="btn btn-sm btn-primary"
						disabled={saving}
					>
						{saving ? "Saving…" : "Save Agent"}
					</button>
					<button
						type="button"
						class="btn btn-sm btn-secondary"
						onClick={onBack}
					>
						Cancel
					</button>
				</div>
			</form>
		</div>
	);
}

// ── Main Component ──

export function YourTeamSection() {
	const [agents, setAgents] = useState<AgentDef[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [editing, setEditing] = useState<AgentDef | "new" | null>(null);
	const [fetchingAgent, setFetchingAgent] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);

	useEffect(() => {
		loadAgents();
	}, []);

	async function loadAgents() {
		setLoading(true);
		setLoadError(null);
		try {
			const res = await apiFetch("/api/your-team");
			const data = await res.json();
			setAgents(data.agents ?? []);
		} catch {
			setLoadError("Failed to load agents. Please refresh.");
		}
		setLoading(false);
	}

	async function openEditor(name: string) {
		setFetchingAgent(true);
		try {
			const res = await apiFetch(`/api/your-team/${encodeURIComponent(name)}`);
			const data = await res.json();
			const agent = data.agent ?? data;
			setEditing({
				name: agent.name ?? name,
				description: agent.description ?? "",
				model: agent.model ?? "sonnet",
				tools: agent.tools ?? [],
				prompt: agent.body ?? agent.prompt ?? "",
			});
		} catch {
			setDeleteError("Failed to load agent details.");
		}
		setFetchingAgent(false);
	}

	async function handleDelete(name: string) {
		setDeleteError(null);
		try {
			await apiFetch(`/api/your-team/${encodeURIComponent(name)}`, {
				method: "DELETE",
			});
			setAgents((prev) => prev.filter((a) => a.name !== name));
		} catch {
			setDeleteError(`Failed to delete "${name}". Please try again.`);
		}
	}

	// Edit / create view
	if (editing !== null) {
		return (
			<div class="content-section">
				<div class="home-content">
					<AgentDefEditor
						initial={editing === "new" ? null : editing}
						isNew={editing === "new"}
						onBack={() => setEditing(null)}
						onSaved={() => {
							setEditing(null);
							loadAgents();
						}}
					/>
				</div>
			</div>
		);
	}

	// List view
	return (
		<div class="content-section">
			<div class="home-content">
				<div class="home-header">
					<div>
						<div class="home-title">
							<IconBot size={20} />
							<span>Your Team</span>
						</div>
						<p class="home-subtitle">
							Define the agents that make up your team —{" "}
							{agents.length > 0
								? `${agents.length} ${agents.length === 1 ? "agent" : "agents"} configured`
								: "no agents yet"}
						</p>
					</div>
					<button
						class="btn btn-sm btn-primary"
						onClick={() => setEditing("new")}
						disabled={fetchingAgent}
					>
						<IconPlus size={14} /> New Agent
					</button>
				</div>

				{deleteError && <div class="yt-error">{deleteError}</div>}

				{loading || fetchingAgent ? (
					<div class="empty-state">
						<p class="yt-count">
							{fetchingAgent ? "Loading agent…" : "Loading…"}
						</p>
					</div>
				) : loadError ? (
					<div class="empty-state">
						<p class="text-error">{loadError}</p>
						<button
							class="btn btn-sm btn-secondary"
							style="margin-top: 12px"
							onClick={loadAgents}
						>
							Retry
						</button>
					</div>
				) : agents.length === 0 ? (
					<div class="empty-state">
						<IconBot
							size={40}
							style="color: var(--text-muted); margin-bottom: 16px"
						/>
						<h3>No Agents Yet</h3>
						<p>
							Define the agents that will collaborate in your team. Each agent
							has a role, model, and set of tools.
						</p>
						<button
							class="btn btn-sm btn-primary"
							onClick={() => setEditing("new")}
						>
							<IconPlus size={14} /> Create First Agent
						</button>
					</div>
				) : (
					<div class="your-team-grid">
						{agents.map((agent) => (
							<AgentDefCard
								key={agent.name}
								agent={agent}
								onSelect={() => openEditor(agent.name)}
								onDelete={() => handleDelete(agent.name)}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
