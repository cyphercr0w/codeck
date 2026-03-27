/**
 * PeerExecutionViewer — Mission Control for parallel agent flows.
 *
 * Key fixes from v1:
 * - xterm container uses absolute positioning inside a relative parent with
 *   explicit height (calc-based) so xterm always has real pixel dimensions
 * - Agent names resolved from flow.agents array, not peerSessions map
 * - Unicode chars as literal strings, not escape sequences
 * - Back button for navigation
 */

import { h, type FunctionalComponent } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
	activeFlowExecution,
	openPeerTerminal,
	togglePeerTerminal,
	flowStateVersion,
	peerMessageLog,
	type ActiveFlowState,
	type PeerMessageEntry,
} from "../../state/chat-store";
import {
	createTerminal,
	destroyTerminal,
	ensureTerminalVisible,
	fitTerminal,
	hasTerminal,
} from "../../terminal";
import { attachSession } from "../../ws";

// ── Helpers ──

type AgentState = "spawning" | "idle" | "working" | "done" | "failed";

const SAFE_DECISION_CLASSES = new Set([
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
	if (flow.currentAgentId === agentId) return "working";
	return "idle";
}

function agentNameById(
	id: string,
	agents: Array<{ id: string; name: string }>,
): string {
	if (id.startsWith("orch-")) return "Orchestrator";
	const match = agents.find((a) => a.id === id);
	if (match) return match.name;
	return id.length > 10 ? id.slice(0, 8) + ".." : id;
}

function fmtDuration(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Agent Tile ──

function AgentTile({
	name,
	role,
	isEntry,
	isActive,
	hasSession,
	status,
	decision,
	onClick,
}: {
	name: string;
	role: string;
	isEntry: boolean;
	isActive: boolean;
	hasSession: boolean;
	status: AgentState;
	decision?: string;
	onClick: () => void;
}): h.JSX.Element {
	const statusLabels: Record<AgentState, string> = {
		spawning: "Starting...",
		idle: "Waiting",
		working: "Working",
		done: "Done",
		failed: "Failed",
	};

	return (
		<button
			class={`peer-tile ${status} ${isActive ? "selected" : ""} ${!hasSession ? "no-session" : ""}`}
			onClick={onClick}
			disabled={!hasSession}
		>
			<div class="peer-tile-top">
				<span class={`peer-tile-dot ${status}`} />
				<span class="peer-tile-name">{name}</span>
				{isEntry && <span class="peer-tile-badge">ENTRY</span>}
			</div>
			<div class="peer-tile-role">{role}</div>
			<div class="peer-tile-state">{statusLabels[status]}</div>
			{decision && (
				<div
					class={`peer-tile-decision ${SAFE_DECISION_CLASSES.has(decision.toLowerCase()) ? decision.toLowerCase() : ""}`}
				>
					{decision}
				</div>
			)}
		</button>
	);
}

// ── Message Log ──

function MessageLog({
	messages,
	agents,
	expanded,
	onToggle,
}: {
	messages: PeerMessageEntry[];
	agents: Array<{ id: string; name: string }>;
	expanded: boolean;
	onToggle: () => void;
}): h.JSX.Element {
	const endRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (expanded && endRef.current) {
			endRef.current.scrollIntoView({ behavior: "smooth" });
		}
	}, [messages.length, expanded]);

	return (
		<div class={`peer-msglog ${expanded ? "open" : ""}`}>
			<button class="peer-msglog-bar" onClick={onToggle}>
				<span>{expanded ? "\u25BC" : "\u25B6"}</span>
				<span>Messages {messages.length > 0 && `(${messages.length})`}</span>
			</button>
			{expanded && (
				<div class="peer-msglog-list">
					{messages.length === 0 && (
						<div class="peer-msglog-empty">No agent messages yet</div>
					)}
					{messages.map((m) => (
						<div key={m.id} class={`peer-msg ${m.type}`}>
							<span class="peer-msg-time">
								{new Date(m.timestamp).toLocaleTimeString([], {
									hour: "2-digit",
									minute: "2-digit",
									second: "2-digit",
								})}
							</span>
							<span class="peer-msg-route">
								<strong>{agentNameById(m.from, agents)}</strong>
								{" \u2192 "}
								<strong>{agentNameById(m.to, agents)}</strong>
							</span>
							{m.type === "decision" && (
								<span class="peer-msg-tag">decision</span>
							)}
							<div class="peer-msg-body">
								{m.payload.length > 200
									? m.payload.slice(0, 200) + "..."
									: m.payload}
							</div>
						</div>
					))}
					<div ref={endRef} />
				</div>
			)}
		</div>
	);
}

// ── Status Bar ──

function StatusBar({
	flow,
	onCancel,
	onBack,
}: {
	flow: ActiveFlowState;
	onCancel: () => void;
	onBack: () => void;
}): h.JSX.Element {
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		if (flow.status !== "running") return;
		const t = setInterval(
			() => setElapsed(Math.floor((Date.now() - flow.startedAt) / 1000)),
			1000,
		);
		return () => clearInterval(t);
	}, [flow.status, flow.startedAt]);

	const sessions = Object.keys(flow.peerSessions || {}).length;
	const total = flow.agents.length;

	if (flow.status !== "running") {
		const dur = flow.completedAt
			? fmtDuration(Math.floor((flow.completedAt - flow.startedAt) / 1000))
			: "";
		return (
			<div class={`peer-status ${flow.status}`}>
				<span>
					{flow.status === "completed" ? "\u2713" : "\u2717"} {flow.status}{" "}
					{dur && `\xB7 ${dur}`}
				</span>
				<button class="peer-status-btn" onClick={onBack}>
					Back to flows
				</button>
			</div>
		);
	}

	return (
		<div class="peer-status running">
			<span class="peer-status-pulse" />
			<span>
				{sessions}/{total} agents \xB7 {fmtDuration(elapsed)}
			</span>
			<button class="peer-status-btn danger" onClick={onCancel}>
				Cancel
			</button>
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
	const created = useRef<Set<string>>(new Set());
	const [logOpen, setLogOpen] = useState(false);

	const flow = activeFlowExecution.value;
	const selected = openPeerTerminal.value;
	const msgs = peerMessageLog.value;
	void flowStateVersion.value;

	// Auto-select entrypoint when first session appears
	useEffect(() => {
		if (!flow || flow.status !== "running" || selected) return;
		if (flow.agents.length === 0) return;
		const entryId = flow.agents[0].id;
		if (flow.peerSessions?.[entryId]) {
			togglePeerTerminal(entryId);
		}
	}, [flow?.peerSessions, flow?.status, selected]);

	// Fit terminal when switching agents — use timeout for layout settle
	useEffect(() => {
		if (!selected || !flow?.peerSessions) return;
		const sid = flow.peerSessions[selected];
		if (!sid || !hasTerminal(sid)) return;
		const t = setTimeout(() => {
			fitTerminal(sid);
		}, 80);
		return () => clearTimeout(t);
	}, [selected]);

	// Create and attach terminal for an agent
	function setupTerm(agentId: string, el: HTMLDivElement | null): void {
		if (!el) return;
		const current = activeFlowExecution.value;
		if (!current?.peerSessions) return;
		const sid = current.peerSessions[agentId];
		if (!sid || created.current.has(sid)) return;
		created.current.add(sid);
		createTerminal(sid, el);
		attachSession(sid);
		// ensureTerminalVisible polls until container has dimensions
		setTimeout(() => ensureTerminalVisible(sid), 150);
	}

	// Cleanup terminals after flow ends — delay for final output
	useEffect(() => {
		if (!flow || flow.status === "running") return;
		const timer = setTimeout(() => {
			for (const sid of created.current) {
				try {
					destroyTerminal(sid);
				} catch {
					/* dead */
				}
			}
			created.current.clear();
		}, 5000);
		return () => clearTimeout(timer);
	}, [flow?.status]);

	if (!flow || flow.executionId !== executionId) {
		return (
			<div class="peer-viewer">
				<div class="peer-terminal-empty">Loading flow...</div>
			</div>
		);
	}

	return (
		<div class="peer-viewer">
			{/* Agent Strip */}
			<div class="peer-strip">
				<button class="peer-back-btn" onClick={onBack} title="Back">
					{"\u2190"}
				</button>
				{flow.agents.map((a, i) => (
					<AgentTile
						key={a.id}
						name={a.name}
						role={a.role}
						isEntry={i === 0}
						isActive={selected === a.id}
						hasSession={!!flow.peerSessions?.[a.id]}
						status={deriveStatus(a.id, flow)}
						decision={flow.agentDecisions[a.id]}
						onClick={() => togglePeerTerminal(a.id)}
					/>
				))}
			</div>

			{/* Terminal Area — relative parent with calc height, xterm fills via absolute */}
			<div class="peer-terminal-area">
				{!selected && (
					<div class="peer-terminal-empty">
						{flow.status === "running"
							? "Click an agent tile to view its live terminal"
							: `Flow ${flow.status}`}
					</div>
				)}
				{selected &&
					flow.agents.map((a) => {
						const sid = flow.peerSessions?.[a.id];
						if (selected !== a.id) return null;
						return (
							<div key={a.id} class="peer-term-wrap">
								<div class="peer-term-header">
									<span class="peer-term-label">
										{a.name}
										<span class={`peer-term-badge ${deriveStatus(a.id, flow)}`}>
											{deriveStatus(a.id, flow)}
										</span>
									</span>
									<button
										class="peer-term-close"
										onClick={() => togglePeerTerminal(null)}
									>
										{"\u2715"}
									</button>
								</div>
								{/* This is the KEY fix: the xterm container must have absolute positioning
							    inside a relative parent that has explicit dimensions from the flex layout.
							    Without this, flex:1 + min-height:0 collapses to 0px and xterm renders nothing. */}
								<div class="peer-term-body">
									<div
										class="peer-term-xterm"
										ref={(el) => {
											if (el && sid) setupTerm(a.id, el);
										}}
									/>
								</div>
							</div>
						);
					})}
			</div>

			{/* Message Log */}
			<MessageLog
				messages={msgs}
				agents={flow.agents}
				expanded={logOpen}
				onToggle={() => setLogOpen(!logOpen)}
			/>

			{/* Status Bar */}
			<StatusBar flow={flow} onCancel={onCancel} onBack={onBack} />
		</div>
	);
};

export default PeerExecutionViewer;
