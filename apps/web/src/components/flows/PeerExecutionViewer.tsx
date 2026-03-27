/**
 * PeerExecutionViewer — Mission Control for parallel agent flows.
 *
 * Terminal mounting uses the SAME imperative DOM pattern as ClaudeSection:
 * document.createElement → appendChild → createTerminal → attachSession.
 * Preact ref callbacks produce 0px containers — imperative DOM is the only
 * pattern that reliably gives xterm real pixel dimensions.
 */

import { type FunctionalComponent } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
	activeFlowExecution,
	openPeerTerminal,
	togglePeerTerminal,
	flowStateVersion,
	peerMessageLog,
	type ActiveFlowState,
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
	// In peer model, agents are "working" once they've received a message
	if (flow.activatedAgents?.[agentId]) return "working";
	return "idle";
}

function agentName(
	id: string,
	agents: Array<{ id: string; name: string }>,
): string {
	if (id.startsWith("orch-")) return "Orchestrator";
	return (
		agents.find((a) => a.id === id)?.name ||
		(id.length > 10 ? id.slice(0, 8) + ".." : id)
	);
}

function fmtTime(sec: number): string {
	const m = Math.floor(sec / 60);
	return m > 0 ? `${m}m ${sec % 60}s` : `${sec}s`;
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
	const [logOpen, setLogOpen] = useState(false);
	const [elapsed, setElapsed] = useState(0);

	const flow = activeFlowExecution.value;
	const selected = openPeerTerminal.value;
	const msgs = peerMessageLog.value;
	void flowStateVersion.value;

	// Clean stale terminals from previous flows on mount
	useEffect(() => {
		const container = termContainerRef.current;
		if (!container) return;
		container
			.querySelectorAll(".peer-term-instance")
			.forEach((c) => c.remove());
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
		if (!flow || flow.status !== "running") return;
		const t = setInterval(
			() => setElapsed(Math.floor((Date.now() - flow.startedAt) / 1000)),
			1000,
		);
		return () => clearInterval(t);
	}, [flow?.status, flow?.startedAt]);

	// Auto-select entrypoint
	useEffect(() => {
		if (!flow || flow.status !== "running" || selected) return;
		if (!flow.agents.length) return;
		const entryId = flow.agents[0].id;
		if (flow.peerSessions?.[entryId]) togglePeerTerminal(entryId);
	}, [flow?.peerSessions, flow?.status, selected]);

	// Cleanup handle for pending ResizeObserver from previous switch
	const fitCleanup = useRef<(() => void) | null>(null);

	// Robust fit: always defers to next frame so display:block is rendered,
	// then fit + repaint + focus. Double-rAF ensures browser has painted.
	function ensureFit(sessionId: string): void {
		fitCleanup.current?.();
		fitCleanup.current = null;

		// Double rAF: first waits for style recalc, second for paint.
		// This is the same pattern browsers use for reliable post-layout work.
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
		if (!container || !flow?.peerSessions || !selected) return;

		const sessionId = flow.peerSessions[selected];
		if (!sessionId) return;

		const termId = `peer-term-${sessionId}`;

		// Hide all existing terminal instances
		container.querySelectorAll(".peer-term-instance").forEach((c) => {
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
		el.className = "peer-term-instance";
		el.style.display = "block";
		container.appendChild(el);

		if (!createdTerms.current.has(sessionId)) {
			createdTerms.current.add(sessionId);
			createTerminal(sessionId, el);
			attachSession(sessionId);
			ensureTerminalVisible(sessionId);
			ensureFit(sessionId);
		}
	}, [selected, flow?.peerSessions]);

	// Re-fit active terminal when container resizes (window resize, panel toggle)
	useEffect(() => {
		const container = termContainerRef.current;
		if (!container) return;

		const ro = new ResizeObserver(() => {
			if (!selected || !flow?.peerSessions?.[selected]) return;
			const sid = flow.peerSessions[selected];
			if (hasTerminal(sid)) {
				fitTerminal(sid);
				requestAnimationFrame(() => repaintTerminal(sid));
			}
		});
		ro.observe(container);
		return () => ro.disconnect();
	}, [selected, flow?.peerSessions]);

	// Hide all terminals when deselected
	useEffect(() => {
		if (selected) return;
		const container = termContainerRef.current;
		if (!container) return;
		container.querySelectorAll(".peer-term-instance").forEach((c) => {
			(c as HTMLElement).style.display = "none";
		});
	}, [selected]);

	// Cleanup on flow end: close terminal view, destroy after delay
	useEffect(() => {
		if (!flow || flow.status === "running") return;
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
					.querySelectorAll(".peer-term-instance")
					.forEach((c) => c.remove());
			}
		}, 3000);
		return () => clearTimeout(timer);
	}, [flow?.status]);

	if (!flow || flow.executionId !== executionId) {
		return (
			<div class="peer-viewer">
				<div class="peer-terminal-empty">Loading...</div>
			</div>
		);
	}

	const isRunning = flow.status === "running";
	const sessions = Object.keys(flow.peerSessions || {}).length;

	return (
		<div class="peer-viewer">
			{/* Agent Strip */}
			<div class="peer-strip">
				<button class="peer-back-btn" onClick={onBack}>
					{"\u2190"}
				</button>
				{flow.agents.map((a, i) => {
					const st = deriveStatus(a.id, flow);
					const dec = flow.agentDecisions[a.id];
					return (
						<button
							key={a.id}
							class={`peer-tile ${st}${selected === a.id ? " selected" : ""}${!flow.peerSessions?.[a.id] ? " no-session" : ""}`}
							onClick={() => togglePeerTerminal(a.id)}
							disabled={!flow.peerSessions?.[a.id]}
						>
							<div class="peer-tile-top">
								<span class={`peer-tile-dot ${st}`} />
								<span class="peer-tile-name">{a.name}</span>
								{i === 0 && <span class="peer-tile-badge">ENTRY</span>}
							</div>
							<div class="peer-tile-role">{a.role}</div>
							<div class={`peer-tile-state ${st}`}>{STATUS_LABELS[st]}</div>
							{dec && (
								<div
									class={`peer-tile-decision ${SAFE_CSS.has(dec.toLowerCase()) ? dec.toLowerCase() : ""}`}
								>
									{dec}
								</div>
							)}
						</button>
					);
				})}
			</div>

			{/* Terminal Area */}
			<div class="peer-terminal-area">
				{selected && (
					<div class="peer-term-header">
						<span class="peer-term-label">
							{flow.agents.find((a) => a.id === selected)?.name || selected}
							<span class={`peer-term-badge ${deriveStatus(selected, flow)}`}>
								{STATUS_LABELS[deriveStatus(selected, flow)]}
							</span>
						</span>
						<button
							class="peer-term-close"
							onClick={() => togglePeerTerminal(null)}
						>
							{"\u2715"}
						</button>
					</div>
				)}
				{/* Imperative terminal container — same pattern as .terminal-instances */}
				<div class="peer-term-instances" ref={termContainerRef} />
				{!selected && (
					<div class="peer-terminal-empty">
						{isRunning
							? "Click an agent to view its terminal"
							: `Flow ${flow.status}`}
					</div>
				)}
			</div>

			{/* Message Log */}
			<div class={`peer-msglog ${logOpen ? "open" : ""}`}>
				<button class="peer-msglog-bar" onClick={() => setLogOpen(!logOpen)}>
					<span>{logOpen ? "\u25BC" : "\u25B6"}</span>
					<span>Messages {msgs.length > 0 && `(${msgs.length})`}</span>
				</button>
				{logOpen && (
					<div class="peer-msglog-list">
						{msgs.length === 0 && (
							<div class="peer-msglog-empty">No messages yet</div>
						)}
						{msgs.map((m) => (
							<div key={m.id} class={`peer-msg ${m.type}`}>
								<span class="peer-msg-time">
									{new Date(m.timestamp).toLocaleTimeString([], {
										hour: "2-digit",
										minute: "2-digit",
										second: "2-digit",
									})}
								</span>
								<span class="peer-msg-route">
									<strong>{agentName(m.from, flow.agents)}</strong>
									{" \u2192 "}
									<strong>{agentName(m.to, flow.agents)}</strong>
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
					</div>
				)}
			</div>

			{/* Status Bar */}
			<div class={`peer-status ${flow.status}`}>
				{isRunning && <span class="peer-status-pulse" />}
				<span>
					{isRunning
						? `${sessions}/${flow.agents.length} agents \xB7 ${fmtTime(elapsed)}`
						: `${flow.status === "completed" ? "\u2713" : "\u2717"} ${flow.status}${
								flow.completedAt
									? ` \xB7 ${fmtTime(Math.floor((flow.completedAt - flow.startedAt) / 1000))}`
									: ""
							}`}
				</span>
				<button class="peer-status-btn" onClick={isRunning ? onCancel : onBack}>
					{isRunning ? "Cancel" : "Back to flows"}
				</button>
			</div>
		</div>
	);
};

export default PeerExecutionViewer;
