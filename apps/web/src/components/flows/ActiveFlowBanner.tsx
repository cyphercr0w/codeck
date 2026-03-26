import { useState, useEffect } from "preact/hooks";

export function ActiveFlowBanner({
	flow,
	onOpen,
}: {
	flow: {
		flowName: string;
		agents: Array<{ id: string; name: string }>;
		currentAgentId: string | null;
		agentDurations: Record<string, number>;
		agentOutputs: Record<string, string>;
		startedAt: number;
	};
	onOpen: () => void;
}) {
	const [elapsed, setElapsed] = useState(() =>
		Math.max(0, Math.floor((Date.now() - flow.startedAt) / 1000)),
	);
	useEffect(() => {
		const iv = setInterval(
			() =>
				setElapsed(
					Math.max(0, Math.floor((Date.now() - flow.startedAt) / 1000)),
				),
			1000,
		);
		return () => clearInterval(iv);
	}, [flow.startedAt]);
	const currentAgent = flow.agents.find((a) => a.id === flow.currentAgentId);
	const doneCount = Object.keys(flow.agentDurations).length;
	const lastOutput = flow.currentAgentId
		? flow.agentOutputs[flow.currentAgentId] || ""
		: "";
	const lastLine = lastOutput.trim().split("\n").pop()?.slice(0, 120) || "";
	return (
		<div class="flow-active-banner" onClick={onOpen}>
			<div class="flow-active-top">
				<span class="spinner-sm" />
				<strong>{flow.flowName}</strong>
				<span class="flow-active-progress">
					{doneCount}/{flow.agents.length} agents
				</span>
				<span class="flow-active-time">{elapsed}s</span>
			</div>
			<div class="flow-active-detail">
				{currentAgent && (
					<span class="flow-active-agent">
						Running: <strong>{currentAgent.name}</strong>
					</span>
				)}
				{lastLine && <span class="flow-active-preview">{lastLine}</span>}
			</div>
			<div class="flow-active-nodes">
				{flow.agents.map((a) => {
					const isDone = flow.agentDurations[a.id] != null;
					const isCurrent = flow.currentAgentId === a.id;
					return (
						<span
							key={a.id}
							class={`flow-active-dot${isDone ? " done" : isCurrent ? " current" : ""}`}
							title={a.name}
						/>
					);
				})}
			</div>
		</div>
	);
}
