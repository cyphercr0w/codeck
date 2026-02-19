import { useEffect, useState } from 'preact/hooks';
import { apiFetch } from '../api';
import { IconFolder, IconRefresh, IconArrowUp, IconEdit, IconSave, IconX, getFileIcon } from './Icons';

interface FileItem {
  name: string;
  isDirectory: boolean;
  size: number;
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

  // Reset state
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState('');

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

  async function handleReset() {
    setResetting(true);
    setResetMsg('');
    try {
      const res = await apiFetch('/api/presets/reset', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setResetMsg('Defaults restored');
        setShowResetConfirm(false);
        loadFiles(dirPath);
        setTimeout(() => setResetMsg(''), 3000);
      } else {
        setResetMsg(data.error || 'Reset failed');
      }
    } catch {
      setResetMsg('Reset failed');
    }
    setResetting(false);
  }

  useEffect(() => {
    loadFiles('');
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

  return (
    <div class="content-section">
      <div class="config-content">
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

        {/* Reset to defaults */}
        {!viewingFile && !loading && items.length > 0 && (
          <div class="config-reset-section">
            {resetMsg && <span class={`config-save-msg ${resetMsg === 'Defaults restored' ? 'success' : 'error'}`}>{resetMsg}</span>}
            {showResetConfirm ? (
              <div class="config-reset-confirm">
                <span>This will overwrite all config files (CLAUDE.md, rules, skills, preferences, memory) with defaults. Continue?</span>
                <div class="config-reset-actions">
                  <button class="btn btn-sm btn-secondary" onClick={() => setShowResetConfirm(false)} disabled={resetting}>Cancel</button>
                  <button class="btn btn-sm btn-danger" onClick={handleReset} disabled={resetting}>
                    {resetting ? <span class="loading" /> : null}
                    Reset
                  </button>
                </div>
              </div>
            ) : (
              <button class="btn btn-sm btn-secondary" onClick={() => setShowResetConfirm(true)}>Restore defaults</button>
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
    </div>
  );
}
