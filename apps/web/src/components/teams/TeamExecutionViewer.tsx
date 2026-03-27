/**
 * TeamExecutionViewer — Canvas visualization + expandable agent terminal.
 *
 * Default: full-canvas view showing all agents as nodes with status badges.
 * Click agent: expands to 50% canvas (left) + 50% terminal (right).
 * Back/Escape: collapses terminal, returns to canvas-only.
 *
 * Only ONE terminal is ever rendered at a time to keep rendering simple.
 */

import { type FunctionalComponent } from "preact";
import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import {
	activeTeam,
	selectedAgentSessionId,
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
	const selectedSession = selectedAgentSessionId.value;
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [terminalSessionId, setTerminalSessionId] = useState<string | null>(
		null,
	);
	const termContainerRef = useRef<HTMLDivElement>(null);
	const activeTermRef = useRef<string | null>(null);

	// ── Open terminal for an agent ──
	const openTerminal = useCallback((sessionId: string) => {
		if (activeTermRef.current && activeTermRef.current !== sessionId) {
			destroyTerminal(activeTermRef.current);
		}
		setTerminalSessionId(sessionId);
		setTerminalOpen(true);
		selectTeamAgent(sessionId);
	}, []);

	// ── Close terminal ──
	const closeTerminal = useCallback(() => {
		if (activeTermRef.current) {
			destroyTerminal(activeTermRef.current);
			activeTermRef.current = null;
		}
		setTerminalOpen(false);
		setTerminalSessionId(null);
	}, []);

	// ── Mount/unmount terminal when sessionId changes ──
	useEffect(() => {
		const container = termContainerRef.current;
		if (!container || !terminalOpen || !terminalSessionId) return;

		// Remove previous children safely (no innerHTML)
		while (container.firstChild) container.removeChild(container.firstChild);

		const el = document.createElement("div");
		el.className = "team-term-instance";
		el.style.cssText = "position:absolute;inset:0;";
		container.appendChild(el);

		activeTermRef.current = terminalSessionId;
		createTerminal(terminalSessionId, el);
		attachSession(terminalSessionId);
		ensureTerminalVisible(terminalSessionId);

		requestAnimationFrame(() => {
			fitTerminal(terminalSessionId);
			focusTerminal(terminalSessionId);
		});

		return () => {
			if (activeTermRef.current === terminalSessionId) {
				destroyTerminal(terminalSessionId);
				activeTermRef.current = null;
			}
		};
	}, [terminalSessionId, terminalOpen]);

	// ── Resize terminal on container resize ──
	useEffect(() => {
		const container = termContainerRef.current;
		if (!container || !terminalOpen || !terminalSessionId) return;

		const observer = new ResizeObserver(() => {
			if (hasTerminal(terminalSessionId)) fitTerminal(terminalSessionId);
		});
		observer.observe(container);
		return () => observer.disconnect();
	}, [terminalSessionId, terminalOpen]);

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
			if (activeTermRef.current) {
				destroyTerminal(activeTermRef.current);
				activeTermRef.current = null;
			}
		};
	}, []);

	if (!team) {
		return <div class="team-empty">No active team</div>;
	}

	const isRunning = team.status === "running" || team.status === "launching";
	const agentCount = team.agents.filter((a) => a.sessionId).length + 1;

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
