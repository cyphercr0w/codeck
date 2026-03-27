/**
 * Mission Control — Side-by-side agent graph + terminal viewer for peer flows.
 *
 * Layout:
 *   Running  → 25% graph panel (left) | 75% terminal (right)
 *   Complete → results card + agent cards + message timeline
 *
 * Terminal mounting uses the SAME imperative DOM pattern as ClaudeSection:
 * document.createElement → appendChild → createTerminal → attachSession.
 * Preact ref callbacks produce 0px containers — imperative DOM is the only
 * pattern that reliably gives xterm real pixel dimensions.
 */

import { type FunctionalComponent } from "preact";
import { useEffect, useRef, useState, useMemo } from "preact/hooks";
import {
	activeFlowExecution,
	openPeerTerminal,
	togglePeerTerminal,
	flowStateVersion,
	peerMessageLog,
	peerCommunicationEdges,
	activeMessageAnimations,
	peerAgentSummaries,
	archivedPeerMessages,
	archivedFlows,
	type ActiveFlowState,
	type PeerMessageEntry,
} from "../../state/chat-store";
import {
	createTerminal,
	destroyTerminal,
	ensureTerminalVisible,
	fitTerminal,
	focusTerminal,
	repaintTerminal,
	hasTerminal,
} from "../../terminal";
import { attachSession } from "../../ws";
import "../../styles/mission-control.css";

// ── Helpers ──

type AgentState = "spawning" | "idle" | "working" | "done" | "failed";

const STATUS_LABELS: Record<AgentState, string> = {
	spawning: "Starting...",
	idle: "Waiting",
	working: "Working",
	done: "Done",
	failed: "Failed",
};

const SAFE_CSS = new Set([
	"approve",
	"done",
	"failed",
	"request_changes",
	"loop",
]);

function deriveStatus(agentId: string, flow: ActiveFlowState): AgentState {
	if (!flow.peerSessions?.[agentId]) return "spawning";
	const dec = flow.agentDecisions[agentId];
	if (dec) return dec === "FAILED" ? "failed" : "done";
	if (flow.activatedAgents?.[agentId]) return "working";
	return "idle";
}

function agentName(
	id: string,
	agents: ReadonlyArray<{ id: string; name: string }>,
): string {
	if (id.startsWith("orch-")) return "Agent Teams";
	return (
		agents.find((a) => a.id === id)?.name ||
		(id.length > 10 ? id.slice(0, 8) + ".." : id)
	);
}

function fmtTime(sec: number): string {
	const m = Math.floor(sec / 60);
	return m > 0 ? `${m}m ${sec % 60}s` : `${sec}s`;
}

function fmtTimestamp(ts: number): string {
	return new Date(ts).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

// ── Sub-components ──

/** Single agent node in the graph panel. */
function AgentNode({
	agent,
	index,
	flow,
	isSelected,
	onSelect,
}: {
	agent: { id: string; name: string; role: string };
	index: number;
	flow: ActiveFlowState;
	isSelected: boolean;
	onSelect: () => void;
}) {
	const st = deriveStatus(agent.id, flow);
	const dec = flow.agentDecisions[agent.id];
	const summary = peerAgentSummaries.value[agent.id];
	const hasSession = !!flow.peerSessions?.[agent.id];
	const startedAt = flow.agentStartedAt[agent.id];

	const [agentElapsed, setAgentElapsed] = useState(0);

	useEffect(() => {
		if (st !== "working" || !startedAt) {
			setAgentElapsed(0);
			return;
		}
		setAgentElapsed(Math.floor((Date.now() - startedAt) / 1000));
		const iv = setInterval(
			() => setAgentElapsed(Math.floor((Date.now() - startedAt) / 1000)),
			1000,
		);
		return () => clearInterval(iv);
	}, [st, startedAt]);

	const classes = [
		"mc-node",
		st,
		isSelected ? "selected" : "",
		!hasSession ? "no-session" : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<button
			class={classes}
			onClick={hasSession ? onSelect : undefined}
			disabled={!hasSession}
		>
			<div class="mc-node-top">
				<span class={`mc-node-dot ${st}`} />
				<span class="mc-node-name">{agent.name}</span>
				{index === 0 && <span class="mc-node-entry-badge">ENTRY</span>}
			</div>
			<div class="mc-node-role">{agent.role}</div>
			<div class="mc-node-status-row">
				<span class="mc-node-status-text">{STATUS_LABELS[st]}</span>
				{st === "working" && agentElapsed > 0 && (
					<span class="mc-node-elapsed">{fmtTime(agentElapsed)}</span>
				)}
			</div>
			{summary && <div class="mc-node-summary">{summary}</div>}
			{dec && (
				<div
					class={`mc-node-decision ${SAFE_CSS.has(dec.toLowerCase()) ? dec.toLowerCase() : ""}`}
				>
					{dec}
				</div>
			)}
		</button>
	);
}

/** Edge connector between two adjacent agent nodes. */
function EdgeConnector({ fromId, toId }: { fromId: string; toId: string }) {
	const edges = peerCommunicationEdges.value;
	const anims = activeMessageAnimations.value;

	const hasEdge = edges.some(
		(e) =>
			(e.fromAgentId === fromId && e.toAgentId === toId) ||
			(e.fromAgentId === toId && e.toAgentId === fromId),
	);
	const hasAnim = anims.some(
		(a) =>
			(a.fromAgentId === fromId && a.toAgentId === toId) ||
			(a.fromAgentId === toId && a.toAgentId === fromId),
	);

	return (
		<div class="mc-edge-container">
			<div class={`mc-edge-line${hasEdge ? " active" : ""}`}>
				{hasAnim && <div class="mc-dot-anim" />}
			</div>
		</div>
	);
}

/** Graph panel showing agent nodes with edge connectors between them. */
function AgentGraph({
	flow,
	selected,
}: {
	flow: ActiveFlowState;
	selected: string | null;
}) {
	// Subscribe to signals that drive graph updates
	void flowStateVersion.value;
	void peerCommunicationEdges.value;
	void activeMessageAnimations.value;
	void peerAgentSummaries.value;

	return (
		<div class="mc-graph-panel">
			<div class="mc-graph-header">Agent Teams</div>
			<div class="mc-graph-area">
				{flow.agents.map((agent, i) => (
					<div key={agent.id}>
						{i > 0 && (
							<EdgeConnector fromId={flow.agents[i - 1].id} toId={agent.id} />
						)}
						<AgentNode
							agent={agent}
							index={i}
							flow={flow}
							isSelected={selected === agent.id}
							onSelect={() => togglePeerTerminal(agent.id)}
						/>
					</div>
				))}
			</div>
		</div>
	);
}

/** Terminal panel with header + imperative xterm container. */
function TerminalPanel({
	flow,
	selected,
	termContainerRef,
}: {
	flow: ActiveFlowState;
	selected: string | null;
	termContainerRef: { current: HTMLDivElement | null };
}) {
	const st = selected ? deriveStatus(selected, flow) : null;
	const agentDef = selected ? flow.agents.find((a) => a.id === selected) : null;
	const isRunning = flow.status === "running";

	return (
		<div class="mc-terminal-panel">
			{selected && (
				<div class="mc-term-header">
					<span class="mc-term-label">
						{agentDef?.name || selected}
						{st && (
							<span class={`mc-term-badge ${st}`}>{STATUS_LABELS[st]}</span>
						)}
					</span>
					<button
						class="mc-term-close"
						onClick={() => togglePeerTerminal(null)}
					>
						{"\u2715"}
					</button>
				</div>
			)}
			{/* Imperative terminal container — same pattern as .terminal-instances */}
			<div class="mc-term-instances" ref={termContainerRef} />
			{!selected && (
				<div class="mc-terminal-empty">
					<span>
						{isRunning
							? "Select an agent to view its terminal"
							: `Flow ${flow.status}`}
					</span>
					{isRunning && (
						<span class="mc-terminal-empty-hint">
							Click a node in the graph panel
						</span>
					)}
				</div>
			)}
		</div>
	);
}

/** Post-execution results card, agent cards, and message timeline. */
function PostExecutionView({
	flow,
	messages,
}: {
	flow: ActiveFlowState;
	messages: readonly PeerMessageEntry[];
}) {
	const totalDuration = flow.completedAt
		? Math.floor((flow.completedAt - flow.startedAt) / 1000)
		: 0;

	const entryAgent = flow.agents[0];
	const finalDecision = entryAgent ? flow.agentDecisions[entryAgent.id] : null;

	const statusIcon =
		flow.status === "completed"
			? "\u2713"
			: flow.status === "failed"
				? "\u2717"
				: "\u2014";

	return (
		<div class="mc-post">
			{/* Results card */}
			<div class={`mc-results-card ${flow.status}`}>
				<div class="mc-results-header">
					<span class="mc-results-icon">{statusIcon}</span>
					<span class="mc-results-title">
						Flow {flow.status}
						{finalDecision ? ` \u2014 ${finalDecision}` : ""}
					</span>
				</div>
				<div class="mc-results-meta">
					<span>Duration: {fmtTime(totalDuration)}</span>
					<span>Agents: {flow.agents.length}</span>
					{flow.loopCount > 0 && <span>Loops: {flow.loopCount}</span>}
				</div>
			</div>

			{/* Agent cards */}
			<div>
				<div class="mc-post-section-title">Agents</div>
				<div class="mc-post-agents">
					{flow.agents.map((agent) => {
						const dur = flow.agentDurations[agent.id];
						const dec = flow.agentDecisions[agent.id];
						return (
							<div key={agent.id} class="mc-agent-card">
								<div class="mc-agent-card-header">
									<span class="mc-agent-card-name">{agent.name}</span>
								</div>
								<div class="mc-agent-card-role">{agent.role}</div>
								<div class="mc-agent-card-meta">
									{dur != null && (
										<span>{fmtTime(Math.floor(dur / 1000))}</span>
									)}
									{dec && (
										<span
											class={`mc-agent-card-decision ${SAFE_CSS.has(dec.toLowerCase()) ? dec.toLowerCase() : ""}`}
										>
											{dec}
										</span>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</div>

			{/* Message timeline */}
			<div>
				<div class="mc-post-section-title">
					Messages{messages.length > 0 ? ` (${messages.length})` : ""}
				</div>
				<div class="mc-timeline">
					{messages.length === 0 && (
						<div class="mc-timeline-empty">No messages recorded</div>
					)}
					{messages.map((m) => (
						<div
							key={m.id}
							class={`mc-timeline-item${m.type === "decision" ? " decision" : ""}`}
						>
							<div class="mc-timeline-item-header">
								<span class="mc-timeline-time">
									{fmtTimestamp(m.timestamp)}
								</span>
								<span class="mc-timeline-route">
									{agentName(m.from, flow.agents)}
									{" \u2192 "}
									{agentName(m.to, flow.agents)}
								</span>
								{m.type !== "message" && (
									<span class="mc-timeline-type-badge">{m.type}</span>
								)}
							</div>
							{m.payload && (
								<div class="mc-timeline-payload">
									{m.payload.length > 200
										? m.payload.slice(0, 200) + "..."
										: m.payload}
								</div>
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

// ── Main Component ──

interface Props {
	executionId: string;
	onCancel: () => void;
	onBack: () => void;
}

const PeerExecutionViewer: FunctionalComponent<Props> = ({
	executionId,
	onCancel,
	onBack,
}) => {
	const termContainerRef = useRef<HTMLDivElement>(null);
	const createdTerms = useRef<Set<string>>(new Set());
	const [elapsed, setElapsed] = useState(0);

	const flow = activeFlowExecution.value;
	const selected = openPeerTerminal.value;
	const msgs = peerMessageLog.value;
	void flowStateVersion.value;

	// Resolve flow: active or archived
	const resolvedFlow = useMemo(() => {
		if (flow && flow.executionId === executionId) return flow;
		return archivedFlows.value[executionId] ?? null;
	}, [flow, executionId]);

	// Resolve messages: live or archived
	const resolvedMessages = useMemo(() => {
		if (flow && flow.executionId === executionId) return msgs;
		return archivedPeerMessages.value[executionId] ?? [];
	}, [flow, executionId, msgs]);

	// Clean stale terminals from previous flows on mount
	useEffect(() => {
		const container = termContainerRef.current;
		if (!container) return;
		container.querySelectorAll(".mc-term-instance").forEach((c) => c.remove());
		for (const sid of createdTerms.current) {
			try {
				destroyTerminal(sid);
			} catch {
				/* */
			}
		}
		createdTerms.current.clear();
	}, [executionId]);

	// Elapsed timer
	useEffect(() => {
		if (!resolvedFlow || resolvedFlow.status !== "running") return;
		const t = setInterval(
			() =>
				setElapsed(Math.floor((Date.now() - resolvedFlow.startedAt) / 1000)),
			1000,
		);
		return () => clearInterval(t);
	}, [resolvedFlow?.status, resolvedFlow?.startedAt]);

	// Auto-select entrypoint
	useEffect(() => {
		if (!resolvedFlow || resolvedFlow.status !== "running" || selected) return;
		if (!resolvedFlow.agents.length) return;
		const entryId = resolvedFlow.agents[0].id;
		if (resolvedFlow.peerSessions?.[entryId]) togglePeerTerminal(entryId);
	}, [resolvedFlow?.peerSessions, resolvedFlow?.status, selected]);

	// Cleanup handle for pending fit from previous terminal switch
	const fitCleanup = useRef<(() => void) | null>(null);

	// Robust fit: double-rAF ensures browser has painted before fitting.
	function ensureFit(sessionId: string): void {
		fitCleanup.current?.();
		fitCleanup.current = null;

		const raf1 = requestAnimationFrame(() => {
			const raf2 = requestAnimationFrame(() => {
				fitTerminal(sessionId);
				repaintTerminal(sessionId);
				focusTerminal(sessionId);
			});
			fitCleanup.current = () => cancelAnimationFrame(raf2);
		});

		fitCleanup.current = () => cancelAnimationFrame(raf1);
	}

	// ── Terminal lifecycle: imperative DOM, same as ClaudeSection ──
	useEffect(() => {
		const container = termContainerRef.current;
		if (!container || !resolvedFlow?.peerSessions || !selected) return;

		const sessionId = resolvedFlow.peerSessions[selected];
		if (!sessionId) return;

		const termId = `mc-term-${sessionId}`;

		// Hide all existing terminal instances
		container.querySelectorAll(".mc-term-instance").forEach((c) => {
			(c as HTMLElement).style.display = "none";
		});

		// If terminal element already exists, just show it and repaint
		const existing = document.getElementById(termId);
		if (existing) {
			existing.style.display = "block";
			if (hasTerminal(sessionId)) {
				ensureFit(sessionId);
			}
			return;
		}

		// Create new terminal element — imperative DOM, not JSX ref
		const el = document.createElement("div");
		el.id = termId;
		el.className = "mc-term-instance";
		el.style.display = "block";
		container.appendChild(el);

		if (!createdTerms.current.has(sessionId)) {
			createdTerms.current.add(sessionId);
			createTerminal(sessionId, el);
			attachSession(sessionId);
			ensureTerminalVisible(sessionId);
			ensureFit(sessionId);
		}
	}, [selected, resolvedFlow?.peerSessions]);

	// Re-fit active terminal when container resizes
	useEffect(() => {
		const container = termContainerRef.current;
		if (!container) return;

		const ro = new ResizeObserver(() => {
			if (!selected || !resolvedFlow?.peerSessions?.[selected]) return;
			const sid = resolvedFlow.peerSessions[selected];
			if (hasTerminal(sid)) {
				fitTerminal(sid);
				requestAnimationFrame(() => repaintTerminal(sid));
			}
		});
		ro.observe(container);
		return () => ro.disconnect();
	}, [selected, resolvedFlow?.peerSessions]);

	// Hide all terminals when deselected
	useEffect(() => {
		if (selected) return;
		const container = termContainerRef.current;
		if (!container) return;
		container.querySelectorAll(".mc-term-instance").forEach((c) => {
			(c as HTMLElement).style.display = "none";
		});
	}, [selected]);

	// Cleanup on flow end: close terminal view, destroy after delay
	useEffect(() => {
		if (!resolvedFlow || resolvedFlow.status === "running") return;
		togglePeerTerminal(null);
		const timer = setTimeout(() => {
			for (const sid of createdTerms.current) {
				try {
					destroyTerminal(sid);
				} catch {
					/* */
				}
			}
			createdTerms.current.clear();
			const container = termContainerRef.current;
			if (container) {
				container
					.querySelectorAll(".mc-term-instance")
					.forEach((c) => c.remove());
			}
		}, 3000);
		return () => clearTimeout(timer);
	}, [resolvedFlow?.status]);

	// ── Render ──

	if (!resolvedFlow || resolvedFlow.executionId !== executionId) {
		return (
			<div class="mc-root">
				<div class="mc-loading">Loading...</div>
			</div>
		);
	}

	const isRunning = resolvedFlow.status === "running";
	const sessions = Object.keys(resolvedFlow.peerSessions || {}).length;

	return (
		<div class="mc-root">
			{isRunning ? (
				<div class="mc-running">
					<AgentGraph flow={resolvedFlow} selected={selected} />
					<TerminalPanel
						flow={resolvedFlow}
						selected={selected}
						termContainerRef={termContainerRef}
					/>
				</div>
			) : (
				<PostExecutionView flow={resolvedFlow} messages={resolvedMessages} />
			)}

			{/* Status Bar */}
			<div class={`mc-status ${resolvedFlow.status}`}>
				{isRunning && <span class="mc-status-pulse" />}
				<span class="mc-status-text">
					{isRunning
						? `${sessions}/${resolvedFlow.agents.length} agents \xB7 ${fmtTime(elapsed)}`
						: `${resolvedFlow.status === "completed" ? "\u2713" : "\u2717"} ${resolvedFlow.status}${
								resolvedFlow.completedAt
									? ` \xB7 ${fmtTime(Math.floor((resolvedFlow.completedAt - resolvedFlow.startedAt) / 1000))}`
									: ""
							}`}
				</span>
				<button
					class={`mc-status-btn${isRunning ? " danger" : ""}`}
					onClick={isRunning ? onCancel : onBack}
				>
					{isRunning ? "Cancel" : "Back to flows"}
				</button>
			</div>
		</div>
	);
};

export default PeerExecutionViewer;
