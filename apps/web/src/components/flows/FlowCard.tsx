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
	return (
		<div class="flow-card" onClick={onSelect}>
			<div class="flow-card-header">
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
