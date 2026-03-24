import { useState, useEffect, useRef } from 'preact/hooks';
import { apiFetch } from '../api';
import {
  proactiveAgents, agentOutputs, workspacePath, setProactiveAgents,
  removeProactiveAgent, clearAgentOutput, appendAgentOutput,
  type ProactiveAgent,
} from '../state/store';
import {
  IconPlus, IconBot, IconChevronLeft, IconChevronDown, IconChevronUp,
  IconRefresh, IconX, IconEdit,
  IconPlay, IconPause, IconTrash,
} from './Icons';
import { ConfirmModal } from './ConfirmModal';
import { DirSelector } from './agents/DirSelector';
import { AgentForm } from './agents/AgentForm';

const MODEL_LABELS: Record<string, string> = {
  '': 'Default (system)', opus: 'Opus 4.6', sonnet: 'Sonnet 4.5', haiku: 'Haiku 4.5',
};

// ── Helpers ──

function formatRelativeTime(ts: number | null): string {
  if (!ts) return 'Never';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

const CRON_LABELS: Record<string, string> = {
  '*/15 * * * *': 'Every 15 min', '*/30 * * * *': 'Every 30 min',
  '0 * * * *': 'Every hour', '0 */6 * * *': 'Every 6 hours',
  '0 */12 * * *': 'Every 12 hours', '0 0 * * *': 'Daily',
  '0 0 * * 0': 'Weekly', '0 9 * * *': 'Daily 9am',
  '0 9 * * 1-5': 'Weekdays 9am', '0 9 * * 1': 'Weekly Mon 9am',
};

function cronToHuman(cron: string): string {
  return CRON_LABELS[cron] || cron;
}

function formatNextRun(ts: number | null): string {
  if (!ts) return '';
  const diff = ts - Date.now();
  if (diff <= 0) return 'Now';
  if (diff < 60000) return `in ${Math.ceil(diff / 1000)}s`;
  if (diff < 3600000) return `in ${Math.ceil(diff / 60000)}m`;
  if (diff < 86400000) {
    const h = Math.floor(diff / 3600000);
    const m = Math.ceil((diff % 3600000) / 60000);
    return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
  }
  return `in ${Math.floor(diff / 86400000)}d`;
}

// ── Tick hook — forces re-render every second for live countdowns ──

function useNow(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
}

// ── Sub-components ──

interface ExecutionResult {
  executionId: string;
  agentId: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  result: 'success' | 'failure' | 'timeout';
  exitCode: number | null;
  outputLines: number;
  error?: string;
}

function StatusBadge({ status, running }: { status: string; running?: boolean }) {
  if (running) return <span class="badge badge-info">Running</span>;
  const map: Record<string, string> = {
    active: 'badge-success',
    paused: 'badge-warning',
    error: 'badge-error',
    success: 'badge-success',
    failure: 'badge-error',
    timeout: 'badge-warning',
  };
  return <span class={`badge ${map[status] || 'badge-muted'}`}>{status}</span>;
}

// ── Agent Card ──

function AgentCard({ agent, onSelect, onAction, onEdit }: {
  agent: ProactiveAgent;
  onSelect: () => void;
  onAction: (action: string) => void;
  onEdit: () => void;
}) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  useNow();

  return (
    <>
      <div class="dash-card agent-card" onClick={onSelect}>
        <div class="agent-card-header">
          <div class="agent-card-title">{agent.name}</div>
          <StatusBadge status={agent.status} running={agent.running} />
        </div>
        <div class="agent-card-objective">{agent.objective}</div>
        <div class="dash-meta" style="border-top: none; margin-top: 0; padding-top: 0">
          <span>{cronToHuman(agent.schedule)}</span>
          {agent.model && (
            <> &middot; <span class="badge badge-muted">{MODEL_LABELS[agent.model] || agent.model || 'Default'}</span></>
          )}
          <> &middot; Last: {formatRelativeTime(agent.lastExecutionAt)}</>
          {agent.nextRunAt && agent.status === 'active' && (
            <> &middot; Next: {formatNextRun(agent.nextRunAt)}</>
          )}
          <> &middot; Runs: {agent.totalExecutions}</>
        </div>
        <div class="agent-card-actions" onClick={e => e.stopPropagation()}>
          {agent.status === 'active' ? (
            <button class="btn btn-xs btn-secondary" onClick={() => onAction('pause')}>
              <IconPause size={11} /> Pause
            </button>
          ) : (
            <button class="btn btn-xs btn-primary" onClick={() => onAction('resume')}>
              <IconPlay size={11} /> Resume
            </button>
          )}
          <button class="btn btn-xs btn-secondary" onClick={() => onAction('execute')} disabled={agent.running || agent.status !== 'active'}>
            <IconPlay size={11} /> Run Now
          </button>
          <button class="btn btn-xs btn-secondary" onClick={onEdit}>
            <IconEdit size={11} /> Edit
          </button>
          <button class="btn btn-xs btn-ghost danger" onClick={() => setShowDeleteModal(true)}>
            <IconTrash size={11} /> Delete
          </button>
        </div>
      </div>
      <ConfirmModal
        visible={showDeleteModal}
        title={`Delete "${agent.name}"`}
        message="This will permanently delete this agent and all its execution history. This action cannot be undone."
        confirmLabel="Delete Agent"
        onConfirm={() => { setShowDeleteModal(false); onAction('delete'); }}
        onCancel={() => setShowDeleteModal(false)}
      />
    </>
  );
}

// ── Create Agent Modal ──

function CreateAgentModal({ visible, onClose, onCreate }: {
  visible: boolean;
  onClose: () => void;
  onCreate: (data: any) => void;
}) {
  const [creating, setCreating] = useState(false);

  if (!visible) return null;

  async function handleCreate(data: any) {
    setCreating(true);
    try {
      const res = await apiFetch('/api/agents', { method: 'POST', body: JSON.stringify(data) });
      const result = await res.json();
      if (result.error) {
        setCreating(false);
        return;
      }
      onCreate(result);
      onClose();
    } catch {
      // ignore
    }
    setCreating(false);
  }

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" style="max-width: 520px" onClick={e => e.stopPropagation()}>
        <div class="modal-title">
          <IconBot size={18} />
          New Scheduled Agent
        </div>
        <AgentForm
          onSubmit={handleCreate}
          onCancel={onClose}
          submitLabel="Create Agent"
          submitting={creating}
        />
      </div>
    </div>
  );
}

// ── Edit Agent Modal ──

function EditAgentModal({ agent, visible, onClose, onSave }: {
  agent: ProactiveAgent;
  visible: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const [saving, setSaving] = useState(false);

  if (!visible) return null;

  async function handleSave(data: any) {
    setSaving(true);
    try {
      const res = await apiFetch(`/api/agents/${agent.id}`, { method: 'PUT', body: JSON.stringify(data) });
      const result = await res.json();
      if (result.error) {
        setSaving(false);
        return;
      }
      onSave();
      onClose();
    } catch {
      // ignore
    }
    setSaving(false);
  }

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" style="max-width: 520px" onClick={e => e.stopPropagation()}>
        <div class="modal-title">
          <IconEdit size={18} />
          Edit Agent
        </div>
        <AgentForm
          initial={agent}
          onSubmit={handleSave}
          onCancel={onClose}
          submitLabel="Save Changes"
          submitting={saving}
        />
      </div>
    </div>
  );
}

// ── Agent Detail ──

function AgentDetailView({ agent, onBack, onEdit }: {
  agent: ProactiveAgent;
  onBack: () => void;
  onEdit: () => void;
}) {
  const [executions, setExecutions] = useState<ExecutionResult[]>([]);
  const [logContent, setLogContent] = useState<string | null>(null);
  const [objectiveExpanded, setObjectiveExpanded] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  useNow();

  const liveOutput = agentOutputs.value[agent.id] || '';

  useEffect(() => {
    loadExecutions();
    if (agent.running && !agentOutputs.value[agent.id]) {
      loadLiveOutput();
    }
  }, [agent.id]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [liveOutput]);

  async function loadLiveOutput() {
    try {
      const res = await apiFetch(`/api/agents/${agent.id}/output`);
      if (res.ok) {
        const text = await res.text();
        if (text && !agentOutputs.value[agent.id]) {
          appendAgentOutput(agent.id, text);
        }
      }
    } catch { /* ignore */ }
  }

  async function loadExecutions() {
    try {
      const res = await apiFetch(`/api/agents/${agent.id}/executions?limit=20`);
      const data = await res.json();
      setExecutions(data.executions || []);
    } catch { /* ignore */ }
  }

  async function loadLog(startedAt?: number) {
    try {
      const url = startedAt
        ? `/api/agents/${agent.id}/logs?ts=${startedAt}`
        : `/api/agents/${agent.id}/logs`;
      const res = await apiFetch(url);
      if (res.ok) {
        setLogContent(await res.text());
      }
    } catch { /* ignore */ }
  }

  async function handleAction(action: string) {
    try {
      if (action === 'pause') {
        await apiFetch(`/api/agents/${agent.id}/pause`, { method: 'POST' });
      } else if (action === 'resume') {
        await apiFetch(`/api/agents/${agent.id}/resume`, { method: 'POST' });
      } else if (action === 'execute') {
        clearAgentOutput(agent.id);
        await apiFetch(`/api/agents/${agent.id}/execute`, { method: 'POST' });
      }
    } catch { /* ignore */ }
  }

  const objectiveNeedsToggle = agent.objective.length > 200;
  const displayedObjective = objectiveNeedsToggle && !objectiveExpanded
    ? agent.objective.slice(0, 200) + '...'
    : agent.objective;

  return (
    <div class="agent-detail">
      <button class="btn btn-xs btn-ghost" onClick={onBack} style="margin-bottom: 16px">
        <IconChevronLeft size={14} /> Back
      </button>

      <div class="agent-detail-header">
        <div style="display: flex; align-items: center; gap: 12px">
          <h2 style="font-size: 20px; font-weight: 700">{agent.name}</h2>
          <StatusBadge status={agent.status} running={agent.running} />
        </div>
        <div style="display: flex; gap: 6px">
          <button class="btn btn-xs btn-secondary" onClick={onEdit}><IconEdit size={12} /> Edit</button>
          {agent.status === 'active' ? (
            <button class="btn btn-xs btn-secondary" onClick={() => handleAction('pause')}><IconPause size={12} /> Pause</button>
          ) : (
            <button class="btn btn-xs btn-primary" onClick={() => handleAction('resume')}><IconPlay size={12} /> Resume</button>
          )}
          <button class="btn btn-xs btn-secondary" onClick={() => handleAction('execute')} disabled={agent.running || agent.status !== 'active'}>
            <IconPlay size={12} /> Run Now
          </button>
        </div>
      </div>

      <div class="dash-card" style="margin-bottom: 20px">
        <div class="detail-rows">
          <div class="detail-row">
            <span class="detail-label">Objective</span>
            <span>
              {displayedObjective}
              {objectiveNeedsToggle && (
                <button
                  class="btn btn-xs btn-ghost"
                  style="margin-left: 4px"
                  onClick={() => setObjectiveExpanded(!objectiveExpanded)}
                >
                  {objectiveExpanded ? <>Less <IconChevronUp size={11} /></> : <>More <IconChevronDown size={11} /></>}
                </button>
              )}
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Schedule</span>
            <span>{cronToHuman(agent.schedule)} <span style="opacity: 0.5">({agent.schedule})</span></span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Working Dir</span>
            <code>{agent.cwd}</code>
          </div>
          <div class="detail-row">
            <span class="detail-label">Model</span>
            <span>{MODEL_LABELS[agent.model] || agent.model || 'Default' || 'Default (system)'}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Total Executions</span>
            <span>{agent.totalExecutions}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Last Run</span>
            <span>{formatRelativeTime(agent.lastExecutionAt)}</span>
          </div>
          {agent.nextRunAt && agent.status === 'active' && (
            <div class="detail-row">
              <span class="detail-label">Next Run</span>
              <span>{formatNextRun(agent.nextRunAt)}</span>
            </div>
          )}
          {agent.lastResult && (
            <div class="detail-row">
              <span class="detail-label">Last Result</span>
              <StatusBadge status={agent.lastResult} />
            </div>
          )}
        </div>
      </div>

      {/* Live output */}
      {(agent.running || liveOutput) && (
        <div style="margin-bottom: 20px">
          <div class="dash-card-title">
            Live Output {agent.running && <span class="badge badge-info">Running</span>}
          </div>
          <pre class="output-block" ref={outputRef}>{liveOutput || 'Waiting for output...'}</pre>
        </div>
      )}

      {/* Execution history */}
      <div style="margin-bottom: 20px">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px">
          <div class="dash-card-title" style="margin-bottom: 0">Execution History</div>
          <button class="btn btn-xs btn-ghost" onClick={loadExecutions}><IconRefresh size={14} /></button>
        </div>
        {executions.length === 0 ? (
          <div class="dash-meta" style="border-top: none; margin-top: 0; padding-top: 0; text-align: center; padding: 24px">
            No executions yet
          </div>
        ) : (
          <div class="dash-card" style="padding: 0; overflow: hidden">
            {executions.map((ex, i) => (
              <div
                key={ex.executionId}
                class="execution-item"
                onClick={() => loadLog(ex.startedAt)}
                style={i > 0 ? 'border-top: 1px solid var(--border)' : ''}
              >
                <StatusBadge status={ex.result} />
                <span style="color: var(--text-secondary); font-size: 13px">{new Date(ex.startedAt).toLocaleString()}</span>
                <span style="color: var(--text-muted); font-size: 12px">{formatDuration(ex.durationMs)}</span>
                <span style="color: var(--text-muted); font-size: 12px; margin-left: auto">{ex.outputLines} lines</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Log viewer */}
      {logContent !== null && (
        <div style="margin-bottom: 20px">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px">
            <div class="dash-card-title" style="margin-bottom: 0">Log</div>
            <button class="btn btn-xs btn-ghost" onClick={() => setLogContent(null)}><IconX size={14} /></button>
          </div>
          <pre class="output-block">{logContent}</pre>
        </div>
      )}
    </div>
  );
}

// ── Main Component ──

export function AgentsSection() {
  const [createOpen, setCreateOpen] = useState(false);
  const [editAgentId, setEditAgentId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const agents = proactiveAgents.value;

  useEffect(() => {
    loadAgents();
  }, []);

  async function loadAgents() {
    try {
      const res = await apiFetch('/api/agents');
      const data = await res.json();
      setProactiveAgents(data.agents || []);
    } catch { /* ignore */ }
  }

  async function handleAction(agentId: string, action: string) {
    try {
      if (action === 'pause') {
        await apiFetch(`/api/agents/${agentId}/pause`, { method: 'POST' });
      } else if (action === 'resume') {
        await apiFetch(`/api/agents/${agentId}/resume`, { method: 'POST' });
      } else if (action === 'execute') {
        clearAgentOutput(agentId);
        await apiFetch(`/api/agents/${agentId}/execute`, { method: 'POST' });
      } else if (action === 'delete') {
        await apiFetch(`/api/agents/${agentId}`, { method: 'DELETE' });
        removeProactiveAgent(agentId);
        if (selectedAgentId === agentId) setSelectedAgentId(null);
      }
    } catch { /* ignore */ }
  }

  const selectedAgent = agents.find(a => a.id === selectedAgentId);
  const editAgent = agents.find(a => a.id === editAgentId);

  if (selectedAgent) {
    return (
      <div class="content-section">
        <div class="home-content">
          <AgentDetailView
            agent={selectedAgent}
            onBack={() => setSelectedAgentId(null)}
            onEdit={() => setEditAgentId(selectedAgent.id)}
          />
          {editAgent && (
            <EditAgentModal
              agent={editAgent}
              visible={!!editAgentId}
              onClose={() => setEditAgentId(null)}
              onSave={() => loadAgents()}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div class="content-section">
      <div class="home-content">
        <div class="home-header">
          <div>
            <div class="home-title">
              <IconBot size={20} />
              <span>Automated Agents</span>
            </div>
            <p class="home-subtitle">Create agents that run on a schedule — monitoring, testing, maintenance, and more</p>
          </div>
          <button class="btn btn-sm btn-primary" onClick={() => setCreateOpen(true)}>
            <IconPlus size={14} /> New Agent
          </button>
        </div>

        {agents.length === 0 ? (
          <div class="empty-state">
            <IconBot size={40} style="color: var(--text-muted); margin-bottom: 16px" />
            <h3>No Automated Agents</h3>
            <p>Create agents that run on a recurring schedule. Define the prompt, set the interval, and the agent executes automatically.</p>
            <button class="btn btn-sm btn-primary" onClick={() => setCreateOpen(true)}>
              <IconPlus size={14} /> Create Your First Agent
            </button>
          </div>
        ) : (
          <div class="agents-grid">
            {agents.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                onSelect={() => setSelectedAgentId(agent.id)}
                onAction={(action) => handleAction(agent.id, action)}
                onEdit={() => setEditAgentId(agent.id)}
              />
            ))}
          </div>
        )}

        <CreateAgentModal
          visible={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreate={() => loadAgents()}
        />

        {editAgent && !selectedAgentId && (
          <EditAgentModal
            agent={editAgent}
            visible={!!editAgentId}
            onClose={() => setEditAgentId(null)}
            onSave={() => loadAgents()}
          />
        )}
      </div>
    </div>
  );
}
