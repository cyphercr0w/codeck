/**
 * TeamExecutionViewer — Agent tabs + terminal viewer for Agent Teams.
 *
 * Shows a tab bar with each team agent (leader + teammates).
 * Each tab renders an xterm.js terminal connected to the agent's tmux pane
 * via the standard console:attach/output WebSocket pipeline.
 *
 * Terminal mounting uses imperative DOM (same as PeerExecutionViewer/ClaudeSection).
 */

import { type FunctionalComponent } from "preact";
import { useEffect, useRef } from "preact/hooks";
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
	repaintTerminal,
	focusTerminal,
	hasTerminal,
} from "../../terminal";
import { attachSession } from "../../ws";
import { stopTeamExecution } from "../../services/teams-service";
import "../../styles/team-viewer.css";

const TeamExecutionViewer: FunctionalComponent = () => {
	const team = activeTeam.value;
	const selectedSession = selectedAgentSessionId.value;
	const termContainerRef = useRef<HTMLDivElement>(null);
	const createdTerms = useRef(new Set<string>());
	const fitCleanup = useRef<(() => void) | null>(null);

	// ── Terminal lifecycle ──
	useEffect(() => {
		const container = termContainerRef.current;
		if (!container || !selectedSession) return;

		const termId = `team-term-${selectedSession}`;

		// Hide all terminal instances
		container.querySelectorAll(".team-term-instance").forEach((c) => {
			(c as HTMLElement).style.display = "none";
		});

		// Show existing or create new
		const existing = document.getElementById(termId);
		if (existing) {
			existing.style.display = "block";
			if (hasTerminal(selectedSession)) {
				fitCleanup.current?.();
				const raf = requestAnimationFrame(() => {
					fitTerminal(selectedSession);
					repaintTerminal(selectedSession);
					focusTerminal(selectedSession);
				});
				fitCleanup.current = () => cancelAnimationFrame(raf);
			}
			return;
		}

		// Create terminal element — imperative DOM
		const el = document.createElement("div");
		el.id = termId;
		el.className = "team-term-instance";
		el.style.cssText = "position:absolute;inset:0;display:block;";
		container.appendChild(el);

		if (!createdTerms.current.has(selectedSession)) {
			createdTerms.current.add(selectedSession);
			createTerminal(selectedSession, el);
			attachSession(selectedSession);
			ensureTerminalVisible(selectedSession);
			requestAnimationFrame(() => {
				fitTerminal(selectedSession);
				focusTerminal(selectedSession);
			});
		}
	}, [selectedSession]);

	// ── Resize observer ──
	useEffect(() => {
		const container = termContainerRef.current;
		if (!container || !selectedSession) return;

		const observer = new ResizeObserver(() => {
			if (selectedSession && hasTerminal(selectedSession)) {
				fitTerminal(selectedSession);
			}
		});
		observer.observe(container);
		return () => observer.disconnect();
	}, [selectedSession]);

	// ── Cleanup on unmount ──
	useEffect(() => {
		return () => {
			for (const sid of createdTerms.current) {
				destroyTerminal(sid);
			}
			createdTerms.current.clear();
		};
	}, []);

	if (!team) {
		return <div class="team-empty">No active team</div>;
	}

	const allSessions = [
		{
			id: "leader",
			name: "Leader",
			role: "Team Lead",
			sessionId: team.leaderSessionId,
			status:
				team.status === "running" || team.status === "launching"
					? ("running" as const)
					: ("idle" as const),
			isLeader: true,
		},
		...team.agents
			.filter((a) => a.sessionId)
			.map((a) => ({
				id: a.id,
				name: a.name,
				role: a.role,
				sessionId: a.sessionId,
				status: a.status,
				isLeader: false,
			})),
	];

	const isRunning = team.status === "running" || team.status === "launching";

	return (
		<div class="team-viewer">
			<div class="team-header">
				<span class="team-header-title">{team.templateName}</span>
				<span class="team-header-count">
					{allSessions.length} agent{allSessions.length !== 1 ? "s" : ""}
				</span>
				{isRunning && (
					<span class="team-header-status">
						<span class="team-dot-pulse" />
						Running
					</span>
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
						Stop Team
					</button>
				) : (
					<button class="team-close-btn" onClick={() => clearActiveTeam()}>
						Close
					</button>
				)}
			</div>

			<div class="team-tabs">
				{allSessions.map((agent) => {
					const isActive = agent.sessionId === selectedSession;
					return (
						<div
							key={agent.id}
							class={`team-tab${isActive ? " active" : ""}`}
							onClick={() =>
								agent.sessionId && selectTeamAgent(agent.sessionId)
							}
						>
							<span
								class={`team-tab-dot${agent.isLeader ? " leader" : ""}${agent.status === "pending" ? " pending" : ""}`}
							/>
							{agent.name}
						</div>
					);
				})}
			</div>

			<div ref={termContainerRef} class="team-terminal-area" />
		</div>
	);
};

export default TeamExecutionViewer;
