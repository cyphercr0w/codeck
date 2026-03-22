import { activeSubagents, type SubagentInfo } from '../state/store';
import { IconBot, IconChevronDown, IconChevronUp } from './Icons';
import { useState } from 'preact/hooks';

function formatElapsed(startedAt: number, duration?: number): string {
  const ms = duration || (Date.now() - startedAt);
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function AgentTypeIcon({ type }: { type: string }) {
  const colors: Record<string, string> = {
    Explore: 'var(--accent)',
    Plan: 'var(--warning)',
    'code-reviewer': 'var(--success)',
    'security-reviewer': 'var(--error)',
    'general-purpose': 'var(--text-secondary)',
  };
  return (
    <span class="sa-type-dot" style={{ background: colors[type] || 'var(--text-muted)' }} title={type} />
  );
}

function SubagentRow({ agent }: { agent: SubagentInfo }) {
  const isDone = !!agent.duration;
  return (
    <div class={`sa-row${isDone ? ' sa-done' : ''}`}>
      <AgentTypeIcon type={agent.agentType} />
      <div class="sa-row-info">
        <span class="sa-row-type">{agent.agentType}</span>
        <span class="sa-row-line">{agent.lastMessage || agent.lastLine || 'Starting...'}</span>
      </div>
      <span class="sa-row-time">{formatElapsed(agent.startedAt, agent.duration)}</span>
      {!isDone && <span class="spinner-sm" />}
    </div>
  );
}

export function SubagentPanel() {
  const agents = activeSubagents.value;
  const [collapsed, setCollapsed] = useState(false);

  if (agents.length === 0) return null;

  const running = agents.filter(a => !a.duration).length;
  const done = agents.filter(a => !!a.duration).length;

  return (
    <div class="sa-panel">
      <button class="sa-header" onClick={() => setCollapsed(c => !c)}>
        <IconBot size={13} />
        <span class="sa-header-text">
          {running > 0 ? `${running} sub-agent${running > 1 ? 's' : ''} working` : `${done} completed`}
        </span>
        {collapsed ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
      </button>
      {!collapsed && (
        <div class="sa-list">
          {agents.map(a => <SubagentRow key={a.agentId} agent={a} />)}
        </div>
      )}
    </div>
  );
}
