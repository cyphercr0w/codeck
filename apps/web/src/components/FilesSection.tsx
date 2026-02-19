import { useEffect, useState } from 'preact/hooks';
import { currentFilesPath } from '../state/store';
import { apiFetch } from '../api';
import { IconFolder, IconRefresh, IconArrowUp, IconEdit, IconSave, IconX, getFileIcon } from './Icons';

interface FileItem {
  name: string;
  isDirectory: boolean;
  size: number;
  modified?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function FilesSection() {
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const dirPath = currentFilesPath.value;

  // File viewer/editor state
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  async function loadFiles(path: string) {
    currentFilesPath.value = path;
    setLoading(true);
    setError('');
    setViewingFile(null);
    try {
      const res = await apiFetch('/api/files?path=' + encodeURIComponent(path));
      const data = await res.json();
      if (data.success) {
        setItems(data.items);
      } else {
        setError(data.error || 'Error');
      }
    } catch {
      setError('Error loading files');
    }
    setLoading(false);
  }

  async function openFile(relativePath: string) {
    try {
      const res = await apiFetch('/api/files/read?path=' + encodeURIComponent(relativePath));
      const data = await res.json();
      if (data.success) {
        setViewingFile(relativePath);
        setFileContent(data.content);
        setEditContent(data.content);
        setEditing(false);
        setSaveMsg('');
      } else {
        setError(data.error || 'Could not read file');
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
      const res = await apiFetch('/api/files/write', {
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

  useEffect(() => {
    loadFiles(dirPath);
  }, []);

  function navigateUp() {
    if (dirPath) {
      const parent = dirPath.split('/').slice(0, -1).join('/');
      loadFiles(parent);
    }
  }

  function navigateTo(itemPath: string) {
    loadFiles(itemPath);
  }

  // Breadcrumb
  const pathParts = dirPath ? dirPath.split('/') : [];
  const breadcrumbs = [{ label: '/workspace', path: '' }];
  let accumulated = '';
  for (const part of pathParts) {
    accumulated = accumulated ? accumulated + '/' + part : part;
    breadcrumbs.push({ label: part, path: accumulated });
  }

  return (
    <div class="content-section">
      <div class="files-content">
        <div class="files-header">
          <div class="files-breadcrumb">
            {breadcrumbs.map((b, i) => (
              <span key={b.path}>
                {i > 0 && <span class="files-sep">/</span>}
                <button
                  class="files-crumb"
                  onClick={() => loadFiles(b.path)}
                  disabled={i === breadcrumbs.length - 1}
                >
                  {b.label}
                </button>
              </span>
            ))}
          </div>
          <div class="files-actions">
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
          <div class="files-viewer">
            <div class="files-viewer-header">
              <span class="files-viewer-name">{viewingFile.split('/').pop()}</span>
              <div class="files-viewer-actions">
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
              <div class="files-empty">Empty directory</div>
            )}
            {!loading && !error && items.map(item => {
              const itemPath = dirPath ? dirPath + '/' + item.name : item.name;
              return (
                <div
                  key={item.name}
                  class="files-row"
                  onClick={() => item.isDirectory ? navigateTo(itemPath) : openFile(itemPath)}
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
