import { useState } from "preact/hooks";
import { IconChevronDown, IconChevronUp, IconCheck, IconX } from "../Icons";
import type { FlowExecution } from "./flow-types";

const STATUS_ICON: Record<string, string> = {
	completed: "✓",
	failed: "✗",
	running: "⏳",
	pending: "○",
	cancelled: "—",
};

const STATUS_COLOR: Record<string, string> = {
	completed: "var(--success, #22c55e)",
	failed: "var(--error, #ef4444)",
	running: "var(--accent, #6366f1)",
	pending: "var(--text-muted, #888)",
	cancelled: "var(--text-muted, #888)",
};

function formatDuration(ms: number): string {
	if (ms < 60000) return `${Math.round(ms / 1000)}s`;
	return `${Math.round(ms / 60000)}m`;
}

export function ExecutionRow({
	execution,
	onSelect,
}: {
	execution: FlowExecution;
	onSelect?: (execId: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const elapsed = execution.completedAt
		? new Date(execution.completedAt).getTime() -
			new Date(execution.startedAt).getTime()
		: Date.now() - new Date(execution.startedAt).getTime();
	const agentEntries = Object.entries(execution.agentResults);

	return (
		<div class="flow-execution-row">
			<div class="flow-execution-header" onClick={() => setExpanded(!expanded)}>
				<span
					class="flow-execution-status"
					style={{ color: STATUS_COLOR[execution.status] || "inherit" }}
				>
					{STATUS_ICON[execution.status] || "?"}
				</span>
				<span class="flow-execution-time">{execution.status}</span>
				<span class="flow-execution-time">
					{new Date(execution.startedAt).toLocaleString()}
				</span>
				<span class="flow-execution-duration">{formatDuration(elapsed)}</span>
				{expanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
			</div>
			{expanded && (
				<div class="flow-execution-details">
					{agentEntries.map(([id, r]) => (
						<div key={id} class="flow-exec-agent-card">
							<div class="flow-exec-agent-header">
								<span
									class="flow-exec-agent-icon"
									style={{ color: STATUS_COLOR[r.status] || "inherit" }}
								>
									{r.status === "completed" ? (
										<IconCheck size={12} />
									) : (
										<IconX size={12} />
									)}
								</span>
								<span class="flow-exec-agent-name">{id}</span>
								<span
									class="flow-exec-agent-status"
									style={{ color: STATUS_COLOR[r.status] || "inherit" }}
								>
									{r.status}
								</span>
							</div>
							{r.output && (
								<div class="flow-exec-agent-output">
									{r.output.slice(0, 2000)}
								</div>
							)}
						</div>
					))}
					{onSelect && (
						<button
							class="btn btn-xs btn-ghost"
							onClick={(e) => {
								e.stopPropagation();
								onSelect(execution.id);
							}}
							style="margin-top: 6px"
						>
							Open full view →
						</button>
					)}
				</div>
			)}
		</div>
	);
}
