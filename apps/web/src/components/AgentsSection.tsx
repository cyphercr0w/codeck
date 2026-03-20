import { useState, useEffect, useRef } from 'preact/hooks';
import { apiFetch } from '../api';
import {
  proactiveAgents, agentOutputs, workspacePath, setProactiveAgents,
  removeProactiveAgent, clearAgentOutput, appendAgentOutput,
  type ProactiveAgent,
} from '../state/store';
import {
  IconPlus, IconBot, IconChevronLeft, IconChevronDown, IconChevronUp,
  IconRefresh, IconX, IconEdit, IconFolder, IconFolderOpen,
  IconPlay, IconPause, IconTrash,
} from './Icons';
import { ConfirmModal } from './ConfirmModal';

// ── Schedule presets ──

const SCHEDULE_PRESETS = [
  { label: '15 min', cron: '*/15 * * * *' },
  { label: '30 min', cron: '*/30 * * * *' },
  { label: '1 hour', cron: '0 * * * *' },
  { label: '6 hours', cron: '0 */6 * * *' },
  { label: '12 hours', cron: '0 */12 * * *' },
  { label: 'Daily', cron: '0 0 * * *' },
  { label: 'Weekly', cron: '0 0 * * 0' },
];

// ── Model options ──

const MODEL_OPTIONS = [
  { value: '', label: 'Default (system)' },
  { value: 'opus', label: 'Opus 4.6' },
  { value: 'sonnet', label: 'Sonnet 4.5' },
  { value: 'haiku', label: 'Haiku 4.5' },
];

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

function cronToHuman(cron: string): string {
  const preset = SCHEDULE_PRESETS.find(p => p.cron === cron);
  return preset ? `Every ${preset.label}` : cron;
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

// ── Directory Cache ──

const DIR_CACHE_TTL = 30_000; // 30 seconds
const dirCache = new Map<string, { entries: DirEntry[], ts: number }>();

function getCachedDirs(path: string): DirEntry[] | null {
  const cached = dirCache.get(path);
  if (cached && Date.now() - cached.ts < DIR_CACHE_TTL) return cached.entries;
  return null;
}

function setCachedDirs(path: string, entries: DirEntry[]) {
  dirCache.set(path, { entries, ts: Date.now() });
}

async function fetchDirs(relPath: string): Promise<DirEntry[]> {
  const cached = getCachedDirs(relPath);
  if (cached) return cached;

  try {
    const res = await apiFetch(`/api/files?path=${encodeURIComponent(relPath)}&type=dir`);
    const data = await res.json();
    const entries: DirEntry[] = (data.items || []).map((e: any) => ({
      name: e.name,
      path: relPath ? `${relPath}/${e.name}` : e.name,
    }));
    setCachedDirs(relPath, entries);
    return entries;
  } catch {
    return [];
  }
}

// ── Directory Selector ──

interface DirEntry { name: string; path: string; }

function DirSelector({ value, onChange }: {
  value: string;
  onChange: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [relativePath, setRelativePath] = useState('');
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const ws = workspacePath.value;

  // Preload root directory on mount
  useEffect(() => {
    fetchDirs('');
  }, []);

  useEffect(() => {
    if (open) loadDirs(relativePath);
  }, [open, relativePath]);

  function toAbsolute(rel: string): string {
    return rel ? `${ws}/${rel}` : ws;
  }

  async function loadDirs(relPath: string) {
    const cached = getCachedDirs(relPath);
    if (cached) {
      setDirs(cached);
      setLoading(false);
      // Prefetch children in background
      for (const entry of cached) {
        fetchDirs(entry.path);
      }
      return;
    }

    setLoading(true);
    const entries = await fetchDirs(relPath);
    setDirs(entries);
    setLoading(false);

    // Prefetch children in background
    for (const entry of entries) {
      fetchDirs(entry.path);
    }
  }

  function handleSelect(relPath: string) {
    onChange(toAbsolute(relPath));
    setOpen(false);
  }

  function handleNavigate(relPath: string) {
    setRelativePath(relPath);
  }

  function handleParent() {
    const parts = relativePath.split('/').filter(Boolean);
    parts.pop();
    setRelativePath(parts.join('/'));
  }

  const displayPath = toAbsolute(relativePath);

  return (
    <div class="dir-selector">
      <div class="dir-selector-row">
        <input
          type="text"
          class="input"
          value={value}
          onInput={e => onChange((e.target as HTMLInputElement).value)}
          placeholder={`${ws} (default)`}
        />
        <button class="btn btn-xs btn-secondary" type="button" onClick={() => setOpen(!open)} title="Browse directories">
          {open ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
        </button>
      </div>
      {open && (
        <div class="dir-selector-list">
          <div class="dir-selector-header">
            <button class="btn btn-xs btn-ghost" onClick={handleParent} disabled={!relativePath}>
              <IconChevronLeft size={12} /> Up
            </button>
            <span class="dir-selector-path">{displayPath}</span>
            <button class="btn btn-xs btn-primary" onClick={() => handleSelect(relativePath)}>
              Select
            </button>
          </div>
          {loading ? (
            <div class="dir-selector-empty"><span class="loading" /> Loading...</div>
          ) : dirs.length === 0 ? (
            <div class="dir-selector-empty">No subdirectories</div>
          ) : (
            dirs.map(d => (
              <div key={d.path} class="dir-selector-item" onClick={() => handleNavigate(d.path)}>
                <IconFolder size={14} />
                <span>{d.name}</span>
                <button class="btn btn-xs btn-ghost" onClick={e => { e.stopPropagation(); handleSelect(d.path); }}>
                  Select
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
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
            <> &middot; <span class="badge badge-muted">{MODEL_OPTIONS.find(m => m.value === agent.model)?.label || agent.model}</span></>
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

// ── Agent Form (shared between Create and Edit) ──

function AgentForm({ initial, onSubmit, onCancel, submitLabel, submitting }: {
  initial?: Partial<ProactiveAgent>;
  onSubmit: (data: any) => void;
  onCancel: () => void;
  submitLabel: string;
  submitting: boolean;
}) {
  const [name, setName] = useState(initial?.name || '');
  const [objective, setObjective] = useState(initial?.objective || '');
  const [schedule, setSchedule] = useState(initial?.schedule || '0 * * * *');
  const [customCron, setCustomCron] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(!!initial);
  const [cwd, setCwd] = useState(initial?.cwd || workspacePath.value);
  const [model, setModel] = useState(initial?.model || '');
  const [timeoutMin, setTimeoutMin] = useState(initial?.timeoutMs ? Math.round(initial.timeoutMs / 60000) : 5);
  const [maxRetries, setMaxRetries] = useState(initial?.maxRetries || 3);
  const [error, setError] = useState('');

  const isPreset = SCHEDULE_PRESETS.some(p => p.cron === schedule);
  const selectedCron = customCron || schedule;

  function handleSubmit() {
    if (!name.trim() || !objective.trim()) {
      setError('Name and objective are required');
      return;
    }
    setError('');
    onSubmit({
      name: name.trim(),
      objective: objective.trim(),
      schedule: selectedCron,
      cwd: cwd.trim() || workspacePath.value,
      model,
      timeoutMs: timeoutMin * 60000,
      maxRetries,
    });
  }

  return (
    <>
      <div class="form-group">
        <label class="form-label">Name</label>
        <input
          type="text"
          class="input"
          value={name}
          onInput={e => setName((e.target as HTMLInputElement).value)}
          placeholder="e.g. Test Runner"
          maxLength={50}
        />
      </div>

      <div class="form-group">
        <label class="form-label">Objective</label>
        <textarea
          class="input"
          value={objective}
          onInput={e => setObjective((e.target as HTMLTextAreaElement).value)}
          placeholder="e.g. Run the test suite, fix any failures, and commit the fixes"
          rows={3}
          style="resize: vertical; min-height: 60px"
        />
      </div>

      <div class="form-group">
        <label class="form-label">Schedule <span style="opacity: 0.5; font-size: 0.9em">(UTC)</span></label>
        <div class="schedule-presets">
          {SCHEDULE_PRESETS.map(p => (
            <button
              key={p.cron}
              class={`btn btn-xs ${schedule === p.cron && !customCron ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { setSchedule(p.cron); setCustomCron(''); }}
              type="button"
            >
              {p.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          class="input"
          value={customCron || (!isPreset && initial ? schedule : '')}
          onInput={e => setCustomCron((e.target as HTMLInputElement).value)}
          placeholder="Custom cron (e.g. */5 * * * *)"
        />
      </div>

      <button
        class="btn btn-xs btn-ghost"
        style="margin-bottom: 12px"
        onClick={() => setShowAdvanced(!showAdvanced)}
        type="button"
      >
        {showAdvanced ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
        {showAdvanced ? 'Hide' : 'Show'} Advanced
      </button>

      {showAdvanced && (
        <>
          <div class="form-group">
            <label class="form-label">Working Directory</label>
            <DirSelector value={cwd} onChange={setCwd} />
          </div>
          <div class="form-group">
            <label class="form-label">Model</label>
            <select class="input" value={model} onChange={e => setModel((e.target as HTMLSelectElement).value)}>
              {MODEL_OPTIONS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Timeout (minutes)</label>
              <input
                type="number"
                class="input"
                value={timeoutMin}
                onInput={e => setTimeoutMin(parseInt((e.target as HTMLInputElement).value) || 5)}
                min={1}
                max={60}
              />
            </div>
            <div class="form-group">
              <label class="form-label">Max Retries</label>
              <input
                type="number"
                class="input"
                value={maxRetries}
                onInput={e => setMaxRetries(parseInt((e.target as HTMLInputElement).value) || 3)}
                min={1}
                max={10}
              />
            </div>
          </div>
        </>
      )}

      {error && <div class="alert alert-error" style="margin-bottom: 12px">{error}</div>}

      <div class="modal-actions">
        <button class="btn btn-sm btn-secondary" onClick={onCancel} type="button">Cancel</button>
        <button class="btn btn-sm btn-primary" onClick={handleSubmit} disabled={submitting} type="button">
          {submitting ? <><span class="loading" /> {submitLabel}...</> : submitLabel}
        </button>
      </div>
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
            <span>{MODEL_OPTIONS.find(m => m.value === agent.model)?.label || agent.model || 'Default (system)'}</span>
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
