import { useEffect, useRef, useState } from 'preact/hooks';
import { apiFetch } from '../api';
import { ConfirmModal } from './ConfirmModal';
import { IconBrain, IconFolder, IconRefresh, IconArrowUp, IconEdit, IconSave, IconX, IconPlus, getFileIcon } from './Icons';

// ── Types ──

interface FileItem {
  name: string;
  isDirectory: boolean;
  size: number;
}

interface PresetStatus {
  configured: boolean;
  presetId: string | null;
  presetName: string | null;
  version: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
}

interface MemoryStats {
  sessionsRemembered: number;
  totalMemoryKB: number;
  dailyLogCount: number;
  decisionsCount: number;
  projectsTracked: number;
  lastActivityAt: number | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatTimeAgo(ts: number | null): string {
  if (!ts) return 'Never';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'Just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ── Types ──

interface SkillEntry {
  source: string;
  skillId: string;
  name: string;
  installs: number;
}

// ── Skill Marketplace ──

function SkillMarketplace({ onInstalled }: { onInstalled: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load top skills on mount
  useEffect(() => { searchSkills(''); }, []);

  function searchSkills(q: string) {
    setLoading(true);
    apiFetch(`/api/skills/catalog?q=${encodeURIComponent(q)}`)
      .then(r => r.json())
      .then(data => setResults(data.skills || []))
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }

  function handleInput(q: string) {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => searchSkills(q), 300);
  }

  async function handleInstall(skill: SkillEntry) {
    setInstalling(skill.skillId);
    setMsg(null);
    try {
      const res = await apiFetch('/api/skills/install', {
        method: 'POST',
        body: JSON.stringify({ source: skill.source, skillId: skill.skillId }),
      });
      const data = await res.json();
      if (data.success) {
        setMsg({ type: 'success', text: `Installed ${skill.name}` });
        onInstalled();
      } else {
        setMsg({ type: 'error', text: data.error || 'Installation failed' });
      }
    } catch {
      setMsg({ type: 'error', text: 'Connection error' });
    }
    setInstalling(null);
    setTimeout(() => setMsg(null), 4000);
  }

  function formatInstalls(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  return (
    <div class="skill-market">
      <input
        class="skill-search"
        placeholder={`Search ${results.length > 0 ? results.length : '...'} skills from skills.sh...`}
        value={query}
        onInput={e => handleInput((e.target as HTMLInputElement).value)}
      />
      {msg && <div class={`fb-toast fb-toast-${msg.type}`}>{msg.text}</div>}
      <div class="skill-list">
        {loading && results.length === 0 && (
          <div class="fb-empty"><span class="spinner-sm" /> Loading skills...</div>
        )}
        {!loading && results.length === 0 && query && (
          <div class="fb-empty">No skills found for "{query}"</div>
        )}
        {results.map(skill => (
          <div key={`${skill.source}/${skill.skillId}`} class="skill-item">
            <div class="skill-item-info">
              <span class="skill-item-name">{skill.name}</span>
              <span class="skill-item-source">{skill.source}</span>
            </div>
            <span class="skill-item-installs">{formatInstalls(skill.installs)}</span>
            <button
              class="btn btn-xs btn-primary"
              onClick={() => handleInstall(skill)}
              disabled={installing !== null}
            >
              {installing === skill.skillId ? <span class="spinner-sm" /> : 'Install'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Quick Input (rules/preferences/skills) ──

function QuickInput({ onSaved }: { onSaved: () => void }) {
  const [type, setType] = useState<'preference' | 'rule' | 'skill'>('preference');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function handleSave() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSaving(true);
    setMsg(null);

    try {
      if (type === 'preference') {
        const readRes = await apiFetch('/api/codeck/files/read?path=preferences.md');
        const readData = await readRes.json();
        const current = readData.success ? readData.content : '';
        const newContent = current.trimEnd() + '\n- ' + trimmed + '\n';
        const writeRes = await apiFetch('/api/codeck/files/write', {
          method: 'PUT',
          body: JSON.stringify({ path: 'preferences.md', content: newContent }),
        });
        const writeData = await writeRes.json();
        if (writeData.success) {
          setMsg({ type: 'success', text: 'Preference saved' });
          setText('');
          onSaved();
        } else {
          setMsg({ type: 'error', text: writeData.error || 'Failed' });
        }
      } else {
        const filename = trimmed.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.md';
        const content = `# ${trimmed.split('\n')[0]}\n\n${trimmed}\n`;
        const writeRes = await apiFetch('/api/codeck/files/write', {
          method: 'PUT',
          body: JSON.stringify({ path: `rules/user/${filename}`, content }),
        });
        const writeData = await writeRes.json();
        if (writeData.success) {
          setMsg({ type: 'success', text: `Rule saved as ${filename}` });
          setText('');
          onSaved();
        } else {
          setMsg({ type: 'error', text: writeData.error || 'Failed' });
        }
      }
    } catch {
      setMsg({ type: 'error', text: 'Connection error' });
    }
    setSaving(false);
    setTimeout(() => setMsg(null), 3000);
  }

  return (
    <div class="mem-quick">
      <div class="mem-quick-tabs">
        <button class={`mem-quick-tab${type === 'preference' ? ' active' : ''}`} onClick={() => setType('preference')}>
          Preference
        </button>
        <button class={`mem-quick-tab${type === 'rule' ? ' active' : ''}`} onClick={() => setType('rule')}>
          Rule
        </button>
        <button class={`mem-quick-tab${type === 'skill' ? ' active' : ''}`} onClick={() => setType('skill')}>
          Skills
        </button>
      </div>
      <div class="mem-quick-body">
        {type === 'skill' ? (
          <SkillMarketplace onInstalled={onSaved} />
        ) : (
          <>
            <textarea
              ref={inputRef}
              class="mem-quick-input"
              placeholder={type === 'preference'
                ? 'e.g. Always use TypeScript strict mode...'
                : 'e.g. Never commit directly to main without tests...'
              }
              value={text}
              onInput={e => setText((e.target as HTMLTextAreaElement).value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSave(); }}
              rows={2}
            />
            <div class="mem-quick-footer">
              {msg && <span class={`mem-quick-msg mem-quick-msg-${msg.type}`}>{msg.text}</span>}
              <span class="mem-quick-hint">Ctrl+Enter to save</span>
              <button class="btn btn-xs btn-primary" onClick={handleSave} disabled={saving || !text.trim()}>
                {saving ? <span class="spinner-sm" /> : <IconPlus size={11} />}
                Save
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main Component ──

export function ConfigSection() {
  const [dirPath, setDirPath] = useState('');
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // File viewer/editor
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Preset state
  const [presetStatus, setPresetStatus] = useState<PresetStatus | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [showSwitchModal, setShowSwitchModal] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Memory stats
  const [memStats, setMemStats] = useState<MemoryStats | null>(null);

  async function loadFiles(path: string) {
    setDirPath(path);
    setLoading(true);
    setError('');
    setViewingFile(null);
    try {
      const res = await apiFetch('/api/codeck/files?path=' + encodeURIComponent(path));
      const data = await res.json();
      if (data.success) setItems(data.items);
      else setError(data.error || 'Error');
    } catch {
      setError('Could not load files');
    }
    setLoading(false);
  }

  async function loadPresetStatus() {
    try {
      const res = await apiFetch('/api/presets/status');
      setPresetStatus(await res.json());
    } catch { /* non-fatal */ }
  }

  async function loadMemoryStats() {
    try {
      const res = await apiFetch('/api/dashboard/memory-stats');
      setMemStats(await res.json());
    } catch { /* non-fatal */ }
  }

  async function openFile(relativePath: string) {
    try {
      const res = await apiFetch('/api/codeck/files/read?path=' + encodeURIComponent(relativePath));
      const data = await res.json();
      if (data.success) {
        setViewingFile(relativePath);
        setFileContent(data.content);
        setEditContent(data.content);
        setEditing(false);
        setSaveMsg('');
      }
    } catch {
      setError('Could not read file');
    }
  }

  async function saveFile() {
    if (!viewingFile) return;
    setSaving(true);
    setSaveMsg('');
    try {
      const res = await apiFetch('/api/codeck/files/write', {
        method: 'PUT',
        body: JSON.stringify({ path: viewingFile, content: editContent }),
      });
      const data = await res.json();
      if (data.success) {
        setFileContent(editContent);
        setEditing(false);
        setSaveMsg('Saved');
        setTimeout(() => setSaveMsg(''), 2000);
      } else {
        setSaveMsg(data.error || 'Save failed');
      }
    } catch {
      setSaveMsg('Save failed');
    }
    setSaving(false);
  }

  async function handleUpdate() {
    setUpdating(true);
    setShowUpdateModal(false);
    setActionMsg(null);
    try {
      const res = await apiFetch('/api/presets/update', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setActionMsg({ type: 'success', text: 'Preset updated' });
        loadFiles(dirPath);
        loadPresetStatus();
      } else {
        setActionMsg({ type: 'error', text: data.error || 'Update failed' });
      }
    } catch {
      setActionMsg({ type: 'error', text: 'Update failed' });
    }
    setUpdating(false);
    setTimeout(() => setActionMsg(null), 4000);
  }

  async function handleReset() {
    setResetting(true);
    setShowResetModal(false);
    setActionMsg(null);
    try {
      const res = await apiFetch('/api/presets/reset', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setActionMsg({ type: 'success', text: 'Factory defaults restored' });
        loadFiles(dirPath);
        loadPresetStatus();
        loadMemoryStats();
      } else {
        setActionMsg({ type: 'error', text: data.error || 'Reset failed' });
      }
    } catch {
      setActionMsg({ type: 'error', text: 'Reset failed' });
    }
    setResetting(false);
    setTimeout(() => setActionMsg(null), 4000);
  }

  async function handleSwitchToDefault() {
    setSwitching(true);
    setShowSwitchModal(false);
    setActionMsg(null);
    try {
      const res = await apiFetch('/api/presets/apply', {
        method: 'POST',
        body: JSON.stringify({ presetId: 'default' }),
      });
      const data = await res.json();
      if (data.success) {
        setActionMsg({ type: 'success', text: 'Switched to Default preset' });
        loadFiles(dirPath);
        loadPresetStatus();
      } else {
        setActionMsg({ type: 'error', text: data.error || 'Switch failed' });
      }
    } catch {
      setActionMsg({ type: 'error', text: 'Switch failed' });
    }
    setSwitching(false);
    setTimeout(() => setActionMsg(null), 4000);
  }

  useEffect(() => {
    loadFiles('');
    loadPresetStatus();
    loadMemoryStats();
  }, []);

  function navigateUp() {
    if (dirPath) {
      const parent = dirPath.split('/').slice(0, -1).join('/');
      loadFiles(parent);
    }
  }

  // Breadcrumb
  const pathParts = dirPath ? dirPath.split('/') : [];
  const breadcrumbs = [{ label: '.codeck', path: '' }];
  let accumulated = '';
  for (const part of pathParts) {
    accumulated = accumulated ? accumulated + '/' + part : part;
    breadcrumbs.push({ label: part, path: accumulated });
  }

  const hasUpdate = presetStatus?.updateAvailable ?? false;

  return (
    <div class="content-section">
      <div class="config-content">

        {/* ── Info + Preset Card ── */}
        {!viewingFile && (
          <div class="dash-grid" style="margin-bottom: 16px">
            {/* Memory Stats */}
            <div class="dash-card">
              <div class="dash-card-title">
                <IconBrain size={14} />
                <span>Agent Memory</span>
              </div>
              {memStats ? (
                <div class="mem-stats">
                  <div class="mem-stat">
                    <span class="mem-stat-value">{memStats.sessionsRemembered}</span>
                    <span class="mem-stat-label">sessions</span>
                  </div>
                  <div class="mem-stat">
                    <span class="mem-stat-value">{memStats.projectsTracked}</span>
                    <span class="mem-stat-label">projects</span>
                  </div>
                  <div class="mem-stat">
                    <span class="mem-stat-value">{memStats.decisionsCount}</span>
                    <span class="mem-stat-label">decisions</span>
                  </div>
                  <div class="mem-stat">
                    <span class="mem-stat-value">{memStats.dailyLogCount}</span>
                    <span class="mem-stat-label">daily logs</span>
                  </div>
                  <div class="mem-stat">
                    <span class="mem-stat-value">{memStats.totalMemoryKB} KB</span>
                    <span class="mem-stat-label">total size</span>
                  </div>
                </div>
              ) : (
                <div class="dash-loading"><span class="spinner-sm" /> Loading...</div>
              )}
              {memStats && (
                <div class="dash-meta">
                  Last active: {formatTimeAgo(memStats.lastActivityAt)}
                </div>
              )}
            </div>

            {/* Preset + Version */}
            {presetStatus?.configured && (
              <div class="dash-card">
                <div class="dash-card-title">
                  <IconFolder size={14} />
                  <span>Preset</span>
                </div>
                <div class="mem-preset-info">
                  <div class="mem-preset-row">
                    <span class="mem-preset-label">Name</span>
                    <span>{presetStatus.presetName || 'Unknown'}</span>
                  </div>
                  <div class="mem-preset-row">
                    <span class="mem-preset-label">Version</span>
                    <span>
                      v{presetStatus.version}
                      {hasUpdate && <span class="badge badge-info" style="margin-left: 6px">v{presetStatus.availableVersion}</span>}
                    </span>
                  </div>
                </div>
                <div class="mem-preset-actions">
                  {actionMsg && <span class={`mem-quick-msg mem-quick-msg-${actionMsg.type}`}>{actionMsg.text}</span>}
                  <button
                    class={`btn btn-xs ${hasUpdate ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setShowUpdateModal(true)}
                    disabled={updating || !hasUpdate}
                  >
                    {updating ? <span class="spinner-sm" /> : null}
                    {hasUpdate ? 'Update' : 'Up to Date'}
                  </button>
                  <button class="btn btn-xs btn-ghost" onClick={() => setShowResetModal(true)} disabled={resetting}>
                    {resetting ? <span class="spinner-sm" /> : null}
                    Factory Reset
                  </button>
                  {presetStatus.presetId !== 'default' && (
                    <button class="btn btn-xs btn-primary" onClick={() => setShowSwitchModal(true)} disabled={switching}>
                      {switching ? <span class="spinner-sm" /> : null}
                      Switch to Default
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Quick Input ── */}
        {!viewingFile && (
          <QuickInput onSaved={() => { loadFiles(dirPath); loadMemoryStats(); }} />
        )}

        {/* ── Separator ── */}
        {!viewingFile && <div class="mem-separator" />}

        {/* ── File Browser ── */}
        <div class="fb">
          <div class="fb-toolbar">
            <div class="fb-breadcrumb">
              {breadcrumbs.map((b, i) => (
                <span key={b.path}>
                  {i > 0 && <span class="fb-sep">/</span>}
                  <button
                    class={`fb-crumb${i === breadcrumbs.length - 1 ? ' active' : ''}`}
                    onClick={() => loadFiles(b.path)}
                    disabled={i === breadcrumbs.length - 1}
                  >
                    {i === 0 ? <><IconFolder size={12} /> .codeck</> : b.label}
                  </button>
                </span>
              ))}
            </div>
            <div class="fb-actions">
              {dirPath && (
                <button class="btn btn-xs btn-ghost" onClick={navigateUp} title="Go up">
                  <IconArrowUp size={13} />
                </button>
              )}
              <button class="btn btn-xs btn-ghost" onClick={() => viewingFile ? openFile(viewingFile) : loadFiles(dirPath)} title="Refresh">
                <IconRefresh size={13} />
              </button>
            </div>
          </div>

          {/* File viewer/editor */}
          {viewingFile && (
            <div class="fb-viewer">
              <div class="fb-viewer-header">
                <span class="fb-viewer-name">{viewingFile.split('/').pop()}</span>
                <div class="fb-viewer-actions">
                  {saveMsg && <span class={`fb-save-msg ${saveMsg === 'Saved' ? 'success' : 'error'}`}>{saveMsg}</span>}
                  {editing ? (
                    <>
                      <button class="btn btn-xs btn-secondary" onClick={() => { setEditing(false); setEditContent(fileContent); }}>Cancel</button>
                      <button class="btn btn-xs btn-primary" onClick={saveFile} disabled={saving}>
                        <IconSave size={11} />
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                    </>
                  ) : (
                    <>
                      <button class="btn btn-xs btn-secondary" onClick={() => setEditing(true)}>
                        <IconEdit size={11} /> Edit
                      </button>
                      <button class="btn btn-xs btn-ghost" onClick={() => setViewingFile(null)}>
                        <IconX size={11} /> Close
                      </button>
                    </>
                  )}
                </div>
              </div>
              {editing ? (
                <textarea
                  class="fb-editor"
                  value={editContent}
                  onInput={e => setEditContent((e.target as HTMLTextAreaElement).value)}
                  spellcheck={false}
                />
              ) : (
                <pre class="fb-file-content">{fileContent}</pre>
              )}
            </div>
          )}

          {/* File list */}
          {!viewingFile && (
            <div class="fb-list">
              {loading && <div class="fb-empty"><span class="spinner-sm" /> Loading...</div>}
              {error && <div class="fb-empty fb-error">{error}</div>}
              {!loading && !error && items.length === 0 && (
                <div class="fb-empty">No config files yet. Apply a preset first.</div>
              )}
              {!loading && !error && items.map(item => {
                const itemPath = dirPath ? dirPath + '/' + item.name : item.name;
                return (
                  <div
                    key={item.name}
                    class="fb-row"
                    onClick={() => item.isDirectory ? loadFiles(itemPath) : openFile(itemPath)}
                  >
                    <span class="fb-row-icon">
                      {item.isDirectory ? <IconFolder size={15} /> : getFileIcon(item.name, 15)}
                    </span>
                    <span class="fb-row-name">{item.name}</span>
                    <span class="fb-row-size">{!item.isDirectory ? formatSize(item.size) : ''}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        visible={showUpdateModal}
        title="Update Preset"
        message="This will update scripts, hooks, skills, and CLAUDE.md to the latest version. Your memory, daily logs, preferences, and rules will NOT be touched."
        confirmLabel="Update"
        onConfirm={handleUpdate}
        onCancel={() => setShowUpdateModal(false)}
      />
      <ConfirmModal
        visible={showResetModal}
        title="Factory Reset"
        message="This will DELETE all memory, daily logs, preferences, and rules, and replace everything with factory defaults. This action cannot be undone."
        confirmLabel="Reset Everything"
        onConfirm={handleReset}
        onCancel={() => setShowResetModal(false)}
      />
      <ConfirmModal
        visible={showSwitchModal}
        title="Switch to Default Preset"
        message="This will install the Default preset with memory system, rules, skills, hooks, and MCP servers. Your existing files will NOT be deleted — only new files will be added."
        confirmLabel="Switch"
        onConfirm={handleSwitchToDefault}
        onCancel={() => setShowSwitchModal(false)}
      />
    </div>
  );
}
