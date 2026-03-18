import { useEffect, useState } from 'preact/hooks';
import { apiFetch } from '../api';
import { ConfirmModal } from './ConfirmModal';
import { IconFolder, IconRefresh, IconArrowUp, IconEdit, IconSave, IconX, getFileIcon } from './Icons';

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function ConfigSection() {
  const [dirPath, setDirPath] = useState('');
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // File viewer/editor state
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

  async function loadFiles(path: string) {
    setDirPath(path);
    setLoading(true);
    setError('');
    setViewingFile(null);
    try {
      const res = await apiFetch('/api/codeck/files?path=' + encodeURIComponent(path));
      const data = await res.json();
      if (data.success) {
        setItems(data.items);
      } else {
        setError(data.error || 'Error');
      }
    } catch {
      setError('Could not load config files');
    }
    setLoading(false);
  }

  async function loadPresetStatus() {
    try {
      const res = await apiFetch('/api/presets/status');
      const data = await res.json();
      setPresetStatus(data);
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
        setActionMsg({ type: 'success', text: 'Preset updated successfully' });
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
        {/* Preset management card */}
        {!viewingFile && presetStatus?.configured && (
          <div class="preset-card">
            <div class="preset-card-header">
              <div class="preset-card-info">
                <span class="preset-card-name">{presetStatus.presetName || 'Preset'}</span>
                <span class="preset-card-version">
                  v{presetStatus.version}
                  {hasUpdate && (
                    <span class="preset-update-badge">v{presetStatus.availableVersion} available</span>
                  )}
                </span>
              </div>
              {actionMsg && (
                <span class={`config-save-msg ${actionMsg.type}`}>{actionMsg.text}</span>
              )}
            </div>
            <div class="preset-card-actions">
              <button
                class={`btn btn-sm ${hasUpdate ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setShowUpdateModal(true)}
                disabled={updating || (!hasUpdate)}
              >
                {updating ? <span class="loading" /> : null}
                {hasUpdate ? 'Update Available' : 'Up to Date'}
              </button>
              <button
                class="btn btn-sm btn-ghost"
                onClick={() => setShowResetModal(true)}
                disabled={resetting}
              >
                {resetting ? <span class="loading" /> : null}
                Factory Reset
              </button>
              {presetStatus.presetId !== 'default' && (
                <button
                  class="btn btn-sm btn-primary"
                  onClick={() => setShowSwitchModal(true)}
                  disabled={switching}
                >
                  {switching ? <span class="loading" /> : null}
                  Switch to Default
                </button>
              )}
            </div>
          </div>
        )}

        {/* File browser header */}
        <div class="config-header">
          <div class="config-breadcrumb">
            {breadcrumbs.map((b, i) => (
              <span key={b.path}>
                {i > 0 && <span class="config-sep">/</span>}
                <button
                  class="config-crumb"
                  onClick={() => loadFiles(b.path)}
                  disabled={i === breadcrumbs.length - 1}
                >
                  {b.label}
                </button>
              </span>
            ))}
          </div>
          <div class="config-actions">
            {dirPath && (
              <button class="btn btn-sm btn-ghost" onClick={navigateUp} title="Go up">
                <IconArrowUp size={14} />
              </button>
            )}
            <button class="btn btn-sm btn-ghost" onClick={() => viewingFile ? openFile(viewingFile) : loadFiles(dirPath)} title="Refresh">
              <IconRefresh size={14} />
            </button>
          </div>
        </div>

        {/* File viewer/editor */}
        {viewingFile && (
          <div class="config-viewer">
            <div class="config-viewer-header">
              <span class="config-viewer-name">{viewingFile.split('/').pop()}</span>
              <div class="config-viewer-actions">
                {saveMsg && <span class={`config-save-msg ${saveMsg === 'Saved' ? 'success' : 'error'}`}>{saveMsg}</span>}
                {editing ? (
                  <>
                    <button class="btn btn-sm btn-secondary" onClick={() => { setEditing(false); setEditContent(fileContent); }}>Cancel</button>
                    <button class="btn btn-sm btn-primary" onClick={saveFile} disabled={saving}>
                      <IconSave size={12} />
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                  </>
                ) : (
                  <>
                    <button class="btn btn-sm btn-secondary" onClick={() => setEditing(true)}>
                      <IconEdit size={12} />
                      Edit
                    </button>
                    <button class="btn btn-sm btn-ghost" onClick={() => setViewingFile(null)}>
                      <IconX size={12} />
                      Close
                    </button>
                  </>
                )}
              </div>
            </div>
            {editing ? (
              <textarea
                class="config-editor"
                value={editContent}
                onInput={(e) => setEditContent((e.target as HTMLTextAreaElement).value)}
                spellcheck={false}
              />
            ) : (
              <pre class="config-file-content">{fileContent}</pre>
            )}
          </div>
        )}

        {/* File list */}
        {!viewingFile && (
          <div class="files-list">
            {loading && <div class="files-empty"><span class="loading" /> Loading...</div>}
            {error && <div class="files-empty" style={{ color: 'var(--error)' }}>{error}</div>}
            {!loading && !error && items.length === 0 && (
              <div class="files-empty">No config files yet. Apply a preset first.</div>
            )}
            {!loading && !error && items.map(item => {
              const itemPath = dirPath ? dirPath + '/' + item.name : item.name;
              return (
                <div
                  key={item.name}
                  class="files-row"
                  onClick={() => item.isDirectory ? loadFiles(itemPath) : openFile(itemPath)}
                >
                  <span class="files-row-icon">
                    {item.isDirectory ? <IconFolder size={16} /> : getFileIcon(item.name, 16)}
                  </span>
                  <span class="files-row-name">{item.name}</span>
                  <span class="files-row-size">{!item.isDirectory ? formatSize(item.size) : ''}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Update Preset Modal */}
      <ConfirmModal
        visible={showUpdateModal}
        title="Update Preset"
        message="This will update scripts, hooks, skills, and CLAUDE.md to the latest version. Your memory, daily logs, preferences, and rules will NOT be touched."
        confirmLabel="Update"
        onConfirm={handleUpdate}
        onCancel={() => setShowUpdateModal(false)}
      />

      {/* Factory Reset Modal */}
      <ConfirmModal
        visible={showResetModal}
        title="Factory Reset"
        message="This will DELETE all memory, daily logs, preferences, and rules, and replace everything with factory defaults. This action cannot be undone."
        confirmLabel="Reset Everything"
        onConfirm={handleReset}
        onCancel={() => setShowResetModal(false)}
      />

      {/* Switch to Default Modal */}
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
