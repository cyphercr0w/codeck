import { useState, useEffect, useRef } from 'preact/hooks';
import { apiFetch } from '../api';
import {
  proactiveAgents, agentOutputs, workspacePath, setProactiveAgents,
  removeProactiveAgent, clearAgentOutput, appendAgentOutput,
  type ProactiveAgent,
} from '../state/store';
import { IconPlus, IconBot, IconChevronLeft, IconChevronDown, IconChevronUp, IconRefresh, IconX, IconEdit, IconFolder, IconFolderOpen } from './Icons';

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
  if (running) return <span class="agent-status running">Running</span>;
  return <span class={`agent-status ${status}`}>{status}</span>;
}

// ── Directory Selector ──

interface DirEntry { name: string; path: string; }

function DirSelector({ value, onChange }: {
  value: string;
  onChange: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // relativePath is what we send to the API (relative to workspace root)
  const [relativePath, setRelativePath] = useState('');
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const ws = workspacePath.value;

  useEffect(() => {
    if (open) loadDirs(relativePath);
  }, [open, relativePath]);

  // Convert relative path to absolute using the actual workspace path from the server
  function toAbsolute(rel: string): string {
    return rel ? `${ws}/${rel}` : ws;
  }

  async function loadDirs(relPath: string) {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/files?path=${encodeURIComponent(relPath)}`);
      const data = await res.json();
      const entries = (data.items || [])
        .filter((e: any) => e.isDirectory)
        .map((e: any) => ({
          name: e.name,
          path: relPath ? `${relPath}/${e.name}` : e.name,
        }));
      setDirs(entries);
    } catch {
      setDirs([]);
    }
    setLoading(false);
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
    <div class="agent-dir-selector">
      <div class="agent-dir-input-row">
        <input
          type="text"
          value={value}
          onInput={e => onChange((e.target as HTMLInputElement).value)}
          placeholder={`${ws} (default)`}
        />
        <button class="btn-sm" type="button" onClick={() => setOpen(!open)} title="Browse directories">
          {open ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
        </button>
      </div>
      {open && (
        <div class="agent-dir-list">
          <div class="agent-dir-header">
            <button class="btn-sm btn-ghost" onClick={handleParent} disabled={!relativePath}>
              <IconChevronLeft size={12} /> Up
            </button>
            <span class="agent-dir-current">{displayPath}</span>
            <button class="btn-sm btn-primary" onClick={() => handleSelect(relativePath)}>
              Select
            </button>
          </div>
          {loading ? (
            <div class="agent-dir-loading">Loading...</div>
          ) : dirs.length === 0 ? (
            <div class="agent-dir-loading">No subdirectories</div>
          ) : (
            dirs.map(d => (
              <div key={d.path} class="agent-dir-item" onClick={() => handleNavigate(d.path)}>
                <IconFolder size={14} />
                <span>{d.name}</span>
                <button class="btn-sm btn-ghost" onClick={e => { e.stopPropagation(); handleSelect(d.path); }}>
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
  const [confirming, setConfirming] = useState(false);
  useNow(); // re-render every second for live "Next run" countdown

  return (
    <div class="dash-card agent-card" onClick={onSelect}>
      <div class="agent-card-header">
        <div class="agent-card-title">{agent.name}</div>
        <StatusBadge status={agent.status} running={agent.running} />
      </div>
      <div class="agent-card-objective">{agent.objective}</div>
      <div class="agent-card-meta">
        <span>{cronToHuman(agent.schedule)}</span>
        {agent.model && (
          <span class="agent-model-badge">{MODEL_OPTIONS.find(m => m.value === agent.model)?.label || agent.model}</span>
        )}
        <span>Last: {formatRelativeTime(agent.lastExecutionAt)}</span>
        {agent.nextRunAt && agent.status === 'active' && (
          <span>Next: {formatNextRun(agent.nextRunAt)}</span>
        )}
        <span>Runs: {agent.totalExecutions}</span>
      </div>
      <div class="agent-card-actions" onClick={e => e.stopPropagation()}>
        {agent.status === 'active' ? (
          <button class="btn-sm" onClick={() => onAction('pause')}>Pause</button>
        ) : (
          <button class="btn-sm btn-primary" onClick={() => onAction('resume')}>Resume</button>
        )}
        <button class="btn-sm" onClick={() => onAction('execute')} disabled={agent.running || agent.status !== 'active'}>
          Run Now
        </button>
        <button class="btn-sm" onClick={onEdit}><IconEdit size={12} /> Edit</button>
        {confirming ? (
          <>
            <button class="btn-sm btn-danger" onClick={() => { onAction('delete'); setConfirming(false); }}>Confirm</button>
            <button class="btn-sm" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <button class="btn-sm btn-danger" onClick={() => setConfirming(true)}>Delete</button>
        )}
      </div>
    </div>
  );
}

// ── Create Agent Modal ──

function CreateAgentModal({ visible, onClose, onCreate }: {
  visible: boolean;
  onClose: () => void;
  onCreate: (data: any) => void;
}) {
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [schedule, setSchedule] = useState('0 * * * *');
  const [customCron, setCustomCron] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cwd, setCwd] = useState(workspacePath.value);
  const [model, setModel] = useState('');
  const [timeoutMin, setTimeoutMin] = useState(5);
  const [maxRetries, setMaxRetries] = useState(3);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  if (!visible) return null;

  const selectedCron = customCron || schedule;

  async function handleCreate() {
    if (!name.trim() || !objective.trim()) {
      setError('Name and objective are required');
      return;
    }
    setCreating(true);
    setError('');
    try {
      const body: any = {
        name: name.trim(),
        objective: objective.trim(),
        schedule: selectedCron,
        model,
        timeoutMs: timeoutMin * 60000,
        maxRetries,
      };
      if (cwd.trim() && cwd.trim() !== workspacePath.value) body.cwd = cwd.trim();

      const res = await apiFetch('/api/agents', { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setCreating(false);
        return;
      }
      onCreate(data);
      // Reset
      setName(''); setObjective(''); setSchedule('0 * * * *'); setCustomCron('');
      setCwd(workspacePath.value); setModel(''); setTimeoutMin(5); setMaxRetries(3);
      onClose();
    } catch (e) {
      setError('Failed to create agent');
    }
    setCreating(false);
  }

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal agent-form" onClick={e => e.stopPropagation()}>
        <div class="modal-header">
          <h3>New Proactive Agent</h3>
          <button class="btn-sm btn-ghost" onClick={onClose}><IconX size={18} /></button>
        </div>

        <div class="agent-form-group">
          <label>Name</label>
          <input
            type="text"
            value={name}
            onInput={e => setName((e.target as HTMLInputElement).value)}
            placeholder="e.g. Test Runner"
            maxLength={50}
          />
        </div>

        <div class="agent-form-group">
          <label>Objective</label>
          <textarea
            value={objective}
            onInput={e => setObjective((e.target as HTMLTextAreaElement).value)}
            placeholder="e.g. Run the test suite, fix any failures, and commit the fixes"
            rows={3}
          />
        </div>

        <div class="agent-form-group">
          <label>Schedule <span style="opacity: 0.6; font-size: 0.85em">(UTC)</span></label>
          <div class="agent-schedule-presets">
            {SCHEDULE_PRESETS.map(p => (
              <button
                key={p.cron}
                class={`btn-sm${schedule === p.cron && !customCron ? ' btn-primary' : ''}`}
                onClick={() => { setSchedule(p.cron); setCustomCron(''); }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={customCron}
            onInput={e => setCustomCron((e.target as HTMLInputElement).value)}
            placeholder="Custom cron (e.g. */5 * * * *)"
          />
        </div>

        <button
          class="btn-sm"
          style="margin-bottom: 12px"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? 'Hide' : 'Show'} Advanced
        </button>

        {showAdvanced && (
          <>
            <div class="agent-form-group">
              <label>Working Directory</label>
              <DirSelector value={cwd} onChange={setCwd} />
            </div>
            <div class="agent-form-group">
              <label>Model</label>
              <select value={model} onChange={e => setModel((e.target as HTMLSelectElement).value)}>
                {MODEL_OPTIONS.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div class="agent-form-row">
              <div class="agent-form-group">
                <label>Timeout (minutes)</label>
                <input
                  type="number"
                  value={timeoutMin}
                  onInput={e => setTimeoutMin(parseInt((e.target as HTMLInputElement).value) || 5)}
                  min={1}
                  max={60}
                />
              </div>
              <div class="agent-form-group">
                <label>Max Retries</label>
                <input
                  type="number"
                  value={maxRetries}
                  onInput={e => setMaxRetries(parseInt((e.target as HTMLInputElement).value) || 3)}
                  min={1}
                  max={10}
                />
              </div>
            </div>
          </>
        )}

        {error && <div class="agent-form-error">{error}</div>}

        <div class="modal-actions">
          <button class="btn-sm" onClick={onClose}>Cancel</button>
          <button class="btn-sm btn-primary" onClick={handleCreate} disabled={creating}>
            {creating ? 'Creating...' : 'Create Agent'}
          </button>
        </div>
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
  const [name, setName] = useState(agent.name);
  const [objective, setObjective] = useState(agent.objective);
  const [schedule, setSchedule] = useState(agent.schedule);
  const [customCron, setCustomCron] = useState('');
  const [cwd, setCwd] = useState(agent.cwd);
  const [model, setModel] = useState(agent.model || '');
  const [timeoutMin, setTimeoutMin] = useState(Math.round(agent.timeoutMs / 60000));
  const [maxRetries, setMaxRetries] = useState(agent.maxRetries);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  if (!visible) return null;

  // Check if schedule matches a preset
  const isPreset = SCHEDULE_PRESETS.some(p => p.cron === schedule);
  const selectedCron = customCron || schedule;

  async function handleSave() {
    if (!name.trim() || !objective.trim()) {
      setError('Name and objective are required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body: any = {
        name: name.trim(),
        objective: objective.trim(),
        schedule: selectedCron,
        cwd: cwd.trim() || workspacePath.value,
        model,
        timeoutMs: timeoutMin * 60000,
        maxRetries,
      };

      const res = await apiFetch(`/api/agents/${agent.id}`, { method: 'PUT', body: JSON.stringify(body) });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setSaving(false);
        return;
      }
      onSave();
      onClose();
    } catch (e) {
      setError('Failed to update agent');
    }
    setSaving(false);
  }

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal agent-form" onClick={e => e.stopPropagation()}>
        <div class="modal-header">
          <h3>Edit Agent</h3>
          <button class="btn-sm btn-ghost" onClick={onClose}><IconX size={18} /></button>
        </div>

        <div class="agent-form-group">
          <label>Name</label>
          <input
            type="text"
            value={name}
            onInput={e => setName((e.target as HTMLInputElement).value)}
            placeholder="e.g. Test Runner"
            maxLength={50}
          />
        </div>

        <div class="agent-form-group">
          <label>Objective</label>
          <textarea
            value={objective}
            onInput={e => setObjective((e.target as HTMLTextAreaElement).value)}
            placeholder="e.g. Run the test suite, fix any failures, and commit the fixes"
            rows={4}
          />
        </div>

        <div class="agent-form-group">
          <label>Schedule <span style="opacity: 0.6; font-size: 0.85em">(UTC)</span></label>
          <div class="agent-schedule-presets">
            {SCHEDULE_PRESETS.map(p => (
              <button
                key={p.cron}
                class={`btn-sm${schedule === p.cron && !customCron ? ' btn-primary' : ''}`}
                onClick={() => { setSchedule(p.cron); setCustomCron(''); }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={customCron || (!isPreset ? schedule : '')}
            onInput={e => setCustomCron((e.target as HTMLInputElement).value)}
            placeholder="Custom cron (e.g. */5 * * * *)"
          />
        </div>

        <div class="agent-form-group">
          <label>Working Directory</label>
          <DirSelector value={cwd} onChange={setCwd} />
        </div>

        <div class="agent-form-group">
          <label>Model</label>
          <select value={model} onChange={e => setModel((e.target as HTMLSelectElement).value)}>
            {MODEL_OPTIONS.map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>

        <div class="agent-form-row">
          <div class="agent-form-group">
            <label>Timeout (minutes)</label>
            <input
              type="number"
              value={timeoutMin}
              onInput={e => setTimeoutMin(parseInt((e.target as HTMLInputElement).value) || 5)}
              min={1}
              max={60}
            />
          </div>
          <div class="agent-form-group">
            <label>Max Retries</label>
            <input
              type="number"
              value={maxRetries}
              onInput={e => setMaxRetries(parseInt((e.target as HTMLInputElement).value) || 3)}
              min={1}
              max={10}
            />
          </div>
        </div>

        {error && <div class="agent-form-error">{error}</div>}

        <div class="modal-actions">
          <button class="btn-sm" onClick={onClose}>Cancel</button>
          <button class="btn-sm btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
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
  useNow(); // re-render every second for live "Next run" countdown

  const liveOutput = agentOutputs.value[agent.id] || '';

  useEffect(() => {
    loadExecutions();
    // If agent is running and we have no buffered output, fetch it from server
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
      <button class="btn-sm agent-back-btn" onClick={onBack}>
        <IconChevronLeft size={16} /> Back
      </button>

      <div class="agent-detail-header">
        <div>
          <h2>{agent.name}</h2>
          <StatusBadge status={agent.status} running={agent.running} />
        </div>
        <div class="agent-detail-actions">
          <button class="btn-sm" onClick={onEdit}><IconEdit size={12} /> Edit</button>
          {agent.status === 'active' ? (
            <button class="btn-sm" onClick={() => handleAction('pause')}>Pause</button>
          ) : (
            <button class="btn-sm btn-primary" onClick={() => handleAction('resume')}>Resume</button>
          )}
          <button class="btn-sm" onClick={() => handleAction('execute')} disabled={agent.running || agent.status !== 'active'}>
            Run Now
          </button>
        </div>
      </div>

      <div class="dash-card agent-detail-info">
        <div class="agent-info-row">
          <span class="agent-info-label">Objective</span>
          <span>
            {displayedObjective}
            {objectiveNeedsToggle && (
              <button
                class="agent-objective-toggle"
                onClick={() => setObjectiveExpanded(!objectiveExpanded)}
              >
                {objectiveExpanded ? (
                  <>Show less <IconChevronUp size={12} /></>
                ) : (
                  <>Show more <IconChevronDown size={12} /></>
                )}
              </button>
            )}
          </span>
        </div>
        <div class="agent-info-row">
          <span class="agent-info-label">Schedule</span>
          <span>{cronToHuman(agent.schedule)} ({agent.schedule})</span>
        </div>
        <div class="agent-info-row">
          <span class="agent-info-label">Working Dir</span>
          <span class="agent-cwd-value">{agent.cwd}</span>
        </div>
        <div class="agent-info-row">
          <span class="agent-info-label">Model</span>
          <span>{MODEL_OPTIONS.find(m => m.value === agent.model)?.label || agent.model || 'Default (system)'}</span>
        </div>
        <div class="agent-info-row">
          <span class="agent-info-label">Total Executions</span>
          <span>{agent.totalExecutions}</span>
        </div>
        <div class="agent-info-row">
          <span class="agent-info-label">Last Run</span>
          <span>{formatRelativeTime(agent.lastExecutionAt)}</span>
        </div>
        {agent.nextRunAt && agent.status === 'active' && (
          <div class="agent-info-row">
            <span class="agent-info-label">Next Run</span>
            <span>{formatNextRun(agent.nextRunAt)}</span>
          </div>
        )}
        {agent.lastResult && (
          <div class="agent-info-row">
            <span class="agent-info-label">Last Result</span>
            <span class={`agent-status ${agent.lastResult}`}>{agent.lastResult}</span>
          </div>
        )}
      </div>

      {/* Live output */}
      {(agent.running || liveOutput) && (
        <div class="agent-output-section">
          <h3>Live Output {agent.running && <span class="agent-status running">Running</span>}</h3>
          <pre class="agent-output" ref={outputRef}>{liveOutput || 'Waiting for output...'}</pre>
        </div>
      )}

      {/* Execution history */}
      <div class="agent-executions-section">
        <div class="agent-executions-header">
          <h3>Execution History</h3>
          <button class="btn-sm" onClick={loadExecutions}><IconRefresh size={14} /></button>
        </div>
        {executions.length === 0 ? (
          <div class="agent-empty-state">No executions yet</div>
        ) : (
          <div class="agent-executions">
            {executions.map(ex => (
              <div
                key={ex.executionId}
                class="agent-execution-item"
                onClick={() => loadLog(ex.startedAt)}
              >
                <StatusBadge status={ex.result} />
                <span class="agent-exec-time">{new Date(ex.startedAt).toLocaleString()}</span>
                <span class="agent-exec-duration">{formatDuration(ex.durationMs)}</span>
                <span class="agent-exec-lines">{ex.outputLines} lines</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Log viewer */}
      {logContent !== null && (
        <div class="agent-output-section">
          <div class="agent-executions-header">
            <h3>Latest Log</h3>
            <button class="btn-sm" onClick={() => setLogContent(null)}><IconX size={14} /></button>
          </div>
          <pre class="agent-output">{logContent}</pre>
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
          <div class="home-title">
            <IconBot size={20} />
            <span>Proactive Agents</span>
          </div>
          <button class="btn-sm btn-primary" onClick={() => setCreateOpen(true)}>
            <IconPlus size={14} /> New Agent
          </button>
        </div>

        {agents.length === 0 ? (
          <div class="agents-empty">
            <IconBot size={48} class="agents-empty-icon" />
            <h3>No Proactive Agents</h3>
            <p>Create autonomous agents that run tasks on a schedule using Claude CLI in non-interactive mode.</p>
            <button class="btn-sm btn-primary" onClick={() => setCreateOpen(true)}>
              Create Your First Agent
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
