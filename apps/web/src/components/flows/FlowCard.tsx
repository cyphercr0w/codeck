import { IconEdit, IconTrash } from "../Icons";
import type { FlowDef } from "./flow-types";

export function FlowCard({
	flow,
	onSelect,
	onEdit,
	onDelete,
}: {
	flow: FlowDef;
	onSelect: () => void;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const agentCount = Object.keys(flow.agents).length;
	// Template-specific icons
	const icon = flow.name.includes("Review")
		? "\uD83D\uDD0D"
		: flow.name.includes("TDD")
			? "\uD83E\uDDEA"
			: flow.name.includes("Fullstack") || flow.name.includes("Builder")
				? "\uD83C\uDFD7\uFE0F"
				: flow.name.includes("Production") || flow.name.includes("Prompt")
					? "\uD83D\uDE80"
					: "\u2699\uFE0F";
	return (
		<div class="flow-card" onClick={onSelect}>
			<div class="flow-card-header">
				<span class="flow-card-icon">{icon}</span>
				<span class="flow-card-name">{flow.name}</span>
				{flow.isTemplate && <span class="flow-card-badge">Template</span>}
			</div>
			<p class="flow-card-desc">{flow.description}</p>
			<div class="flow-card-meta">
				<span>
					{agentCount} agent{agentCount !== 1 ? "s" : ""}
				</span>
				<span>v{flow.version}</span>
			</div>
			<div class="flow-card-actions" onClick={(e) => e.stopPropagation()}>
				<button class="btn-icon" onClick={onEdit} title="Edit">
					<IconEdit size={14} />
				</button>
				{!flow.isTemplate && (
					<button
						class="btn-icon btn-danger"
						onClick={() => {
							if (confirm(`Delete flow "${flow.name}"?`)) onDelete();
						}}
						title="Delete"
					>
						<IconTrash size={14} />
					</button>
				)}
			</div>
		</div>
	);
}
