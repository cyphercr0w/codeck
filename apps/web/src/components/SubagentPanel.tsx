import { activeSubagents, type SubagentInfo } from "../state/store";
import { IconBot, IconChevronDown, IconChevronUp } from "./Icons";
import { useState, useEffect, useRef } from "preact/hooks";

function formatElapsed(startedAt: number, duration?: number): string {
	const ms = duration || Date.now() - startedAt;
	if (ms < 1000) return "<1s";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function AgentTypeIcon({ type }: { type: string }) {
	const colors: Record<string, string> = {
		Explore: "var(--accent)",
		Plan: "var(--warning)",
		"code-reviewer": "var(--success)",
		"security-reviewer": "var(--error)",
		"general-purpose": "var(--text-secondary)",
	};
	return (
		<span
			class="sa-type-dot"
			style={{ background: colors[type] || "var(--text-muted)" }}
			title={type}
		/>
	);
}

const AGENT_INITIAL_STATUS: Record<string, string> = {
	Explore: "Scanning codebase...",
	Plan: "Analyzing requirements...",
	"code-reviewer": "Reviewing changes...",
	"typescript-reviewer": "Checking TypeScript...",
	"security-reviewer": "Scanning for vulnerabilities...",
	"general-purpose": "Processing task...",
	"rust-reviewer": "Reviewing Rust code...",
	"java-reviewer": "Reviewing Java code...",
	"kotlin-reviewer": "Reviewing Kotlin code...",
};

function statusText(agent: SubagentInfo): string {
	if (agent.lastMessage) return agent.lastMessage;
	if (agent.lastLine) return agent.lastLine;
	if (agent.duration) return "Completed";
	return (
		AGENT_INITIAL_STATUS[agent.agentType] || `Running ${agent.agentType}...`
	);
}

function TranscriptView({
	lines,
	isRunning,
}: {
	lines: string[];
	isRunning: boolean;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);

	// Auto-scroll to bottom on new lines
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [lines.length]);

	if (lines.length === 0) {
		return (
			<div class="sa-transcript">
				<div class="sa-transcript-empty">
					{isRunning ? "Waiting for output..." : "No output recorded"}
				</div>
			</div>
		);
	}

	return (
		<div class="sa-transcript" ref={scrollRef}>
			{lines.map((line, i) => (
				<div key={i} class="sa-transcript-line">
					{line}
				</div>
			))}
			{isRunning && <div class="sa-transcript-cursor" />}
		</div>
	);
}

function SubagentRow({
	agent,
	expanded,
	onToggle,
}: {
	agent: SubagentInfo;
	expanded: boolean;
	onToggle: () => void;
}) {
	const isDone = !!agent.duration;
	return (
		<div class={`sa-row-wrap${expanded ? " sa-expanded" : ""}`}>
			<button class={`sa-row${isDone ? " sa-done" : ""}`} onClick={onToggle}>
				<AgentTypeIcon type={agent.agentType} />
				<div class="sa-row-info">
					<span class="sa-row-type">{agent.agentType}</span>
					<span class="sa-row-line">{statusText(agent)}</span>
				</div>
				<span class="sa-row-time">
					{formatElapsed(agent.startedAt, agent.duration)}
				</span>
				{!isDone && <span class="spinner-sm" />}
			</button>
			{expanded && <TranscriptView lines={agent.lines} isRunning={!isDone} />}
		</div>
	);
}

export function SubagentPanel({ sessionId }: { sessionId?: string }) {
	const allAgents = activeSubagents.value;
	// Filter to only show sub-agents belonging to the active terminal session
	const agents = sessionId
		? allAgents.filter((a) => a.sessionId === sessionId)
		: allAgents;
	const [collapsed, setCollapsed] = useState(false);
	const [expandedId, setExpandedId] = useState<string | null>(null);

	if (agents.length === 0) return null;

	const running = agents.filter((a) => !a.duration).length;
	const done = agents.filter((a) => !!a.duration).length;

	return (
		<div class={`sa-panel${expandedId ? " sa-panel-expanded" : ""}`}>
			<button class="sa-header" onClick={() => setCollapsed((c) => !c)}>
				<IconBot size={13} />
				<span class="sa-header-text">
					{running > 0
						? `${running} sub-agent${running > 1 ? "s" : ""} working`
						: `${done} completed`}
				</span>
				{collapsed ? (
					<IconChevronUp size={12} />
				) : (
					<IconChevronDown size={12} />
				)}
			</button>
			{!collapsed && (
				<div class="sa-list">
					{agents.map((a) => (
						<SubagentRow
							key={a.agentId}
							agent={a}
							expanded={expandedId === a.agentId}
							onToggle={() =>
								setExpandedId(expandedId === a.agentId ? null : a.agentId)
							}
						/>
					))}
				</div>
			)}
		</div>
	);
}
