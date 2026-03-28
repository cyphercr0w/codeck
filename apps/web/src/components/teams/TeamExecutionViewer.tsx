/**
 * TeamExecutionViewer — Canvas visualization + expandable agent terminal.
 *
 * Default: full-canvas view showing all agents as nodes with status badges.
 * Click agent: expands to 50% canvas (left) + 50% terminal (right).
 * Back/Escape: collapses terminal, returns to canvas-only.
 *
 * Terminal instances are cached per agent: switching agents hides the old
 * terminal (display:none) and shows the new one. Scrollback and canvas
 * state are preserved across switches. All terminals are destroyed on
 * close or component unmount.
 */

import { type FunctionalComponent } from "preact";
import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import { showToast } from "../../state/store";
import {
	activeTeam,
	selectTeamAgent,
	clearActiveTeam,
} from "../../state/team-store";
import {
	createTerminal,
	destroyTerminal,
	ensureTerminalVisible,
	fitTerminal,
	focusTerminal,
	hasTerminal,
} from "../../terminal";
import { attachSession } from "../../ws";
import { stopTeamExecution } from "../../services/teams-service";
import AgentCanvas from "./AgentCanvas";
import "../../styles/team-viewer.css";

const TeamExecutionViewer: FunctionalComponent = () => {
	const team = activeTeam.value;
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [terminalSessionId, setTerminalSessionId] = useState<string | null>(
		null,
	);
	const termContainerRef = useRef<HTMLDivElement>(null);
	/** Cache: sessionId → container div. Terminals persist across agent switches. */
	const terminalContainers = useRef(new Map<string, HTMLDivElement>());

	// ── Open terminal for an agent ──
	const openTerminal = useCallback((sessionId: string) => {
		setTerminalSessionId(sessionId);
		setTerminalOpen(true);
		selectTeamAgent(sessionId);
	}, []);

	// ── Close terminal — destroy ALL cached terminals ──
	const closeTerminal = useCallback(() => {
		for (const [id] of terminalContainers.current) {
			destroyTerminal(id);
		}
		terminalContainers.current.clear();
		setTerminalOpen(false);
		setTerminalSessionId(null);
	}, []);

	// ── Show/create terminal when active session changes ──
	useEffect(() => {
		const container = termContainerRef.current;
		if (!container || !terminalOpen || !terminalSessionId) return;

		// Hide all, show active
		for (const [id, div] of terminalContainers.current) {
			div.style.display = id === terminalSessionId ? "block" : "none";
		}

		// First time for this session → create terminal
		if (!terminalContainers.current.has(terminalSessionId)) {
			const el = document.createElement("div");
			el.className = "team-term-instance";
			el.style.cssText = "position:absolute;inset:0;";
			container.appendChild(el);
			terminalContainers.current.set(terminalSessionId, el);
			createTerminal(terminalSessionId, el);
			attachSession(terminalSessionId);
		}

		// Fit + repaint after visibility change (handles CSS transition timing).
		// ensureTerminalVisible polls with rAF + IntersectionObserver fallback,
		// so it correctly waits for the 0.2s CSS flex transition to settle.
		const cancelEnsure = ensureTerminalVisible(terminalSessionId);
		focusTerminal(terminalSessionId);

		return () => {
			cancelEnsure();
		};
	}, [terminalSessionId, terminalOpen]);

	// NOTE: No duplicate ResizeObserver/IntersectionObserver/setInterval here.
	// createTerminal() in terminal.ts already sets up its own ResizeObserver
	// that handles fit on container size changes.

	// ── Keyboard: Escape closes terminal ──
	useEffect(() => {
		if (!terminalOpen) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") closeTerminal();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [terminalOpen, closeTerminal]);

	// ── Cleanup on unmount ──
	useEffect(() => {
		return () => {
			for (const [id] of terminalContainers.current) {
				destroyTerminal(id);
			}
			terminalContainers.current.clear();
		};
	}, []);

	if (!team) {
		return <div class="team-empty">No active team</div>;
	}

	const isRunning = team.status === "running" || team.status === "launching";
	const isCompleted =
		team.status === "completed" ||
		team.status === "cancelled" ||
		team.status === "failed";
	const agentCount = team.agents.filter((a) => a.sessionId).length + 1;

	// Notify on completion — keep preview open so user can review
	useEffect(() => {
		if (!isCompleted) return;
		const shutdownCount = team.agents.filter(
			(a) => a.status === "shutdown",
		).length;
		const label =
			team.status === "completed"
				? `Team "${team.templateName}" completed — ${shutdownCount} agent${shutdownCount !== 1 ? "s" : ""} finished`
				: team.status === "failed"
					? `Team "${team.templateName}" failed`
					: `Team "${team.templateName}" stopped`;
		showToast(label, team.status === "failed" ? "error" : "success");
	}, [isCompleted]);

	const termAgentName = terminalSessionId
		? terminalSessionId === team.leaderSessionId
			? "Leader"
			: (team.agents.find((a) => a.sessionId === terminalSessionId)?.name ??
				"Agent")
		: "";

	return (
		<div class="team-viewer">
			{/* Header */}
			<div class="team-header">
				<span class="team-header-title">{team.templateName}</span>
				<span class="team-header-count">
					{agentCount} agent{agentCount !== 1 ? "s" : ""}
				</span>
				{isRunning && (
					<span class="team-header-status">
						<span class="team-dot-pulse" />
						Running
					</span>
				)}
				{isCompleted && (
					<span class="team-header-status team-header-done">
						&#10003;{" "}
						{team.status === "completed"
							? "Completed"
							: team.status === "failed"
								? "Failed"
								: "Stopped"}
					</span>
				)}
				{terminalOpen && (
					<button class="team-back-btn" onClick={closeTerminal}>
						&#8592; Canvas
					</button>
				)}
				{isRunning ? (
					<button
						class="team-close-btn team-stop-btn"
						onClick={() => {
							if (team.executionId) {
								stopTeamExecution(team.executionId)
									.then(() => clearActiveTeam())
									.catch(() => clearActiveTeam());
							}
						}}
					>
						Stop
					</button>
				) : (
					<button class="team-close-btn" onClick={() => clearActiveTeam()}>
						Close
					</button>
				)}
			</div>

			{/* Content area */}
			<div class="team-content">
				{/* Canvas — always rendered, shrinks when terminal open */}
				<div class={`team-canvas-area${terminalOpen ? " split" : ""}`}>
					<AgentCanvas onAgentClick={openTerminal} />
				</div>

				{/* Terminal — only when an agent is selected */}
				{terminalOpen && (
					<div class="team-terminal-split">
						<div class="team-terminal-header">
							<span class="team-terminal-agent-name">{termAgentName}</span>
							<button
								class="team-terminal-reload"
								onClick={() => {
									if (terminalSessionId && hasTerminal(terminalSessionId)) {
										fitTerminal(terminalSessionId);
									}
								}}
								title="Resize terminal"
							>
								&#8635;
							</button>
							<button class="team-terminal-close" onClick={closeTerminal}>
								&#215;
							</button>
						</div>
						<div ref={termContainerRef} class="team-terminal-area" />
					</div>
				)}
			</div>
		</div>
	);
};

export default TeamExecutionViewer;
