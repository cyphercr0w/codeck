/**
 * PeerExecutionViewer — Mission Control for parallel agent flows.
 *
 * Layout:
 *   [Agent Strip]  — horizontal tiles showing each agent's state
 *   [Terminal]      — xterm.js for the selected agent (interactive)
 *   [Message Log]   — collapsible drawer showing inter-agent messages
 *   [Status Bar]    — flow progress, elapsed time, cancel button
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

// ── Agent Tile ──

interface AgentTileProps {
	name: string;
	role: string;
	isEntry: boolean;
	isActive: boolean;
	hasSession: boolean;
	status: "spawning" | "idle" | "working" | "done" | "failed";
	decision?: string;
	onClick: () => void;
}

function AgentTile({
	name,
	role,
	isEntry,
	isActive,
	hasSession,
	status,
	decision,
	onClick,
}: AgentTileProps): h.JSX.Element {
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
			{decision && (
				<div
					class={`peer-tile-decision ${
						["approve", "done", "failed", "request_changes", "loop"].includes(
							decision.toLowerCase(),
						)
							? decision.toLowerCase()
							: ""
					}`}
				>
					{decision}
				</div>
			)}
		</button>
	);
}

// ── Message Log ──

interface MessageLogProps {
	messages: PeerMessageEntry[];
	agentNames: Map<string, string>;
	expanded: boolean;
	onToggle: () => void;
}

function MessageLog({
	messages,
	agentNames,
	expanded,
	onToggle,
}: MessageLogProps): h.JSX.Element {
	const endRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (expanded && endRef.current) {
			endRef.current.scrollIntoView({ behavior: "smooth" });
		}
	}, [messages.length, expanded]);

	const name = (id: string): string => {
		if (id.startsWith("orch-")) return "Orchestrator";
		return agentNames.get(id) || id;
	};

	return (
		<div class={`peer-msglog ${expanded ? "open" : ""}`}>
			<button class="peer-msglog-bar" onClick={onToggle}>
				<span>{expanded ? "\u25BC" : "\u25B2"}</span>
				<span>
					Messages
					{messages.length > 0 && ` (${messages.length})`}
				</span>
			</button>
			{expanded && (
				<div class="peer-msglog-list">
					{messages.length === 0 && (
						<div class="peer-msglog-empty">
							Agents haven't exchanged messages yet
						</div>
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
								{name(m.from)} {"\u2192"} {name(m.to)}
							</span>
							{m.type === "decision" && (
								<span class="peer-msg-tag">decision</span>
							)}
							<div class="peer-msg-body">
								{m.payload.length > 200
									? m.payload.slice(0, 200) + "\u2026"
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
}: {
	flow: ActiveFlowState;
	onCancel: () => void;
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

	const fmt = (s: number): string => {
		const m = Math.floor(s / 60);
		return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
	};

	const sessions = Object.keys(flow.peerSessions || {}).length;
	const total = flow.agents.length;

	if (flow.status !== "running") {
		const icon =
			flow.status === "completed"
				? "\u2713"
				: flow.status === "cancelled"
					? "\u2014"
					: "\u2717";
		const dur = flow.completedAt
			? fmt(Math.floor((flow.completedAt - flow.startedAt) / 1000))
			: "";
		return (
			<div class={`peer-status ${flow.status}`}>
				<span>
					{icon} {flow.status}
					{dur && ` \u00B7 ${dur}`}
				</span>
			</div>
		);
	}

	return (
		<div class="peer-status running">
			<span class="peer-status-pulse" />
			<span>
				{sessions}/{total} agents \u00B7 {fmt(elapsed)}
			</span>
			<button class="peer-status-cancel" onClick={onCancel}>
				Cancel
			</button>
		</div>
	);
}

// ── Main Component ──

interface Props {
	executionId: string;
	onCancel: () => void;
}

const PeerExecutionViewer: FunctionalComponent<Props> = ({
	executionId,
	onCancel,
}) => {
	const created = useRef<Set<string>>(new Set());
	const [logOpen, setLogOpen] = useState(false);

	const flow = activeFlowExecution.value;
	const selected = openPeerTerminal.value;
	const msgs = peerMessageLog.value;
	// Subscribe to version signal to trigger re-renders on state changes
	void flowStateVersion.value;

	// Build peerId → name map
	const nameMap = new Map<string, string>();
	if (flow?.peerSessions) {
		for (const a of flow.agents) {
			const pid = flow.peerSessions[a.id];
			if (pid) nameMap.set(pid, a.name);
		}
	}

	// Auto-select entrypoint when first session appears
	useEffect(() => {
		if (!flow || flow.status !== "running" || selected) return;
		if (flow.agents.length === 0) return;
		const entryId = flow.agents[0].id;
		const entrySession = flow.peerSessions?.[entryId];
		if (entrySession) {
			togglePeerTerminal(entryId);
		}
	}, [flow?.peerSessions, flow?.status, selected]);

	// Fit terminal when switching
	useEffect(() => {
		if (!selected || !flow?.peerSessions) return;
		const sid = flow.peerSessions[selected];
		if (sid && hasTerminal(sid)) {
			requestAnimationFrame(() => fitTerminal(sid));
		}
	}, [selected]);

	// Setup terminal for an agent — reads from signal directly to avoid stale closures.
	// No useCallback: the ref callback must always see the latest peerSessions.
	function setupTerm(agentId: string, el: HTMLDivElement | null): void {
		if (!el) return;
		const current = activeFlowExecution.value;
		if (!current?.peerSessions) return;
		const sid = current.peerSessions[agentId];
		if (!sid || created.current.has(sid)) return;
		created.current.add(sid);
		createTerminal(sid, el);
		attachSession(sid);
		ensureTerminalVisible(sid);
	}

	// Cleanup terminals after flow ends — delay to let final output drain
	useEffect(() => {
		if (!flow || flow.status === "running") return;
		const timer = setTimeout(() => {
			for (const sid of created.current) {
				try {
					destroyTerminal(sid);
				} catch {
					/* */
				}
			}
			created.current.clear();
		}, 3000);
		return () => clearTimeout(timer);
	}, [flow?.status]);

	if (!flow || flow.executionId !== executionId) {
		return <div class="peer-viewer">Loading flow...</div>;
	}

	const agentStatus = (
		id: string,
	): "spawning" | "idle" | "working" | "done" | "failed" => {
		if (!flow.peerSessions?.[id]) return "spawning";
		const dec = flow.agentDecisions[id];
		if (dec) return dec === "FAILED" ? "failed" : "done";
		if (flow.currentAgentId === id) return "working";
		return "idle";
	};

	return (
		<div class="peer-viewer">
			<div class="peer-strip">
				{flow.agents.map((a, i) => (
					<AgentTile
						key={a.id}
						name={a.name}
						role={a.role}
						isEntry={i === 0}
						isActive={selected === a.id}
						hasSession={!!flow.peerSessions?.[a.id]}
						status={agentStatus(a.id)}
						decision={flow.agentDecisions[a.id]}
						onClick={() => togglePeerTerminal(a.id)}
					/>
				))}
			</div>

			<div class="peer-terminal-area">
				{!selected && (
					<div class="peer-terminal-empty">
						{flow.status === "running"
							? "Select an agent to view its terminal"
							: `Flow ${flow.status}`}
					</div>
				)}
				{flow.agents.map((a) => {
					const sid = flow.peerSessions?.[a.id];
					const vis = selected === a.id;
					return (
						<div
							key={a.id}
							class="peer-term-wrap"
							style={{ display: vis ? "flex" : "none" }}
						>
							<div class="peer-term-header">
								<span>
									{a.name}
									<span class={`peer-term-status ${agentStatus(a.id)}`}>
										{agentStatus(a.id)}
									</span>
								</span>
								<button
									class="peer-term-close"
									onClick={() => togglePeerTerminal(null)}
								>
									{"\u2715"}
								</button>
							</div>
							<div
								class="peer-term-xterm"
								ref={(el) => {
									if (el && sid && vis) setupTerm(a.id, el);
								}}
							/>
						</div>
					);
				})}
			</div>

			<MessageLog
				messages={msgs}
				agentNames={nameMap}
				expanded={logOpen}
				onToggle={() => setLogOpen(!logOpen)}
			/>

			<StatusBar flow={flow} onCancel={onCancel} />
		</div>
	);
};

export default PeerExecutionViewer;
