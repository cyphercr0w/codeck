import { useEffect, useState, useRef } from 'preact/hooks';
import { currentFilesPath, workspacePath, showToast } from '../state/store';
import { apiFetch } from '../api';
import { IconFolder, IconRefresh, IconArrowUp, IconEdit, IconSave, IconX, IconPlus, IconTrash, IconFile, getFileIcon } from './Icons';

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

/** Full-featured file browser — navigation, create, delete, rename, edit. */
export function FilesBrowser() {
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const dirPath = currentFilesPath.value;
  const ws = workspacePath.value;

  // File viewer/editor
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Create new item
  const [showCreate, setShowCreate] = useState<'file' | 'folder' | null>(null);
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);
  const createRef = useRef<HTMLInputElement>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<FileItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [forceDelete, setForceDelete] = useState(false);

  // Rename
  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);

  // (toasts use global showToast from store)

  async function loadFiles(path: string) {
    currentFilesPath.value = path;
    setLoading(true);
    setError('');
    setViewingFile(null);
    setShowCreate(null);
    setRenameTarget(null);
    setDeleteTarget(null);
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
        showToast(data.error || 'Could not read file', 'error');
      }
    } catch {
      showToast('Could not read file', 'error');
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

  async function handleCreate() {
    const name = createName.trim();
    if (!name) return;
    setCreating(true);
    try {
      if (showCreate === 'folder') {
        const fullRelPath = dirPath ? `${dirPath}/${name}` : name;
        const res = await apiFetch('/api/files/mkdir', {
          method: 'POST',
          body: JSON.stringify({ name: fullRelPath }),
        });
        const data = await res.json();
        if (data.success) {
          showToast(`Folder "${name}" created`, 'success');
        } else {
          showToast(data.error || 'Failed to create folder', 'error');
        }
      } else {
        const fullRelPath = dirPath ? `${dirPath}/${name}` : name;
        const res = await apiFetch('/api/files/write', {
          method: 'PUT',
          body: JSON.stringify({ path: fullRelPath, content: '' }),
        });
        const data = await res.json();
        if (data.success) {
          showToast(`File "${name}" created`, 'success');
        } else {
          showToast(data.error || 'Failed to create file', 'error');
        }
      }
      setShowCreate(null);
      setCreateName('');
      loadFiles(dirPath);
    } catch {
      showToast('Failed to create', 'error');
    }
    setCreating(false);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const relPath = dirPath ? `${dirPath}/${deleteTarget.name}` : deleteTarget.name;
      const res = await apiFetch('/api/files/delete', {
        method: 'DELETE',
        body: JSON.stringify({ path: relPath, force: forceDelete }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(`"${deleteTarget.name}" deleted`, 'success');
      } else {
        showToast(data.error || 'Failed to delete', 'error');
      }
      setDeleteTarget(null);
      loadFiles(dirPath);
    } catch {
      showToast('Failed to delete', 'error');
    }
    setDeleting(false);
  }

  async function handleRename() {
    if (!renameTarget || !renameName.trim()) return;
    setRenaming(true);
    try {
      const oldPath = dirPath ? `${dirPath}/${renameTarget.name}` : renameTarget.name;
      const newPath = dirPath ? `${dirPath}/${renameName.trim()}` : renameName.trim();
      const res = await apiFetch('/api/files/rename', {
        method: 'POST',
        body: JSON.stringify({ oldPath, newPath }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Renamed to "${renameName.trim()}"`, 'success');
      } else {
        showToast(data.error || 'Failed to rename', 'error');
      }
      setRenameTarget(null);
      setRenameName('');
      loadFiles(dirPath);
    } catch {
      showToast('Failed to rename', 'error');
    }
    setRenaming(false);
  }

  useEffect(() => { loadFiles(dirPath); }, []);

  useEffect(() => {
    if (showCreate) setTimeout(() => createRef.current?.focus(), 50);
  }, [showCreate]);

  useEffect(() => {
    if (renameTarget) setTimeout(() => renameRef.current?.focus(), 50);
  }, [renameTarget]);

  function navigateUp() {
    if (dirPath) {
      const parent = dirPath.split('/').slice(0, -1).join('/');
      loadFiles(parent);
    }
  }

  // Breadcrumb
  const pathParts = dirPath ? dirPath.split('/') : [];
  const breadcrumbs = [{ label: ws, path: '' }];
  let accumulated = '';
  for (const part of pathParts) {
    accumulated = accumulated ? accumulated + '/' + part : part;
    breadcrumbs.push({ label: part, path: accumulated });
  }

  return (
    <div class="fb">
      {/* Toolbar */}
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
                {i === 0 ? <><IconFolder size={12} /> workspace</> : b.label}
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
          <button class="btn btn-xs btn-ghost" onClick={() => setShowCreate(showCreate ? null : 'folder')} title="New folder">
            <IconFolder size={13} />
            <IconPlus size={9} />
          </button>
          <button class="btn btn-xs btn-ghost" onClick={() => setShowCreate(showCreate ? null : 'file')} title="New file">
            <IconFile size={13} />
            <IconPlus size={9} />
          </button>
          <button class="btn btn-xs btn-ghost" onClick={() => viewingFile ? openFile(viewingFile) : loadFiles(dirPath)} title="Refresh">
            <IconRefresh size={13} />
          </button>
        </div>
      </div>

      {/* Create inline */}
      {showCreate && (
        <div class="fb-create-row">
          <span class="fb-create-icon">
            {showCreate === 'folder' ? <IconFolder size={14} /> : <IconFile size={14} />}
          </span>
          <input
            ref={createRef}
            class="fb-inline-input"
            placeholder={showCreate === 'folder' ? 'Folder name...' : 'File name...'}
            value={createName}
            onInput={e => setCreateName((e.target as HTMLInputElement).value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreate();
              if (e.key === 'Escape') { setShowCreate(null); setCreateName(''); }
            }}
            disabled={creating}
          />
          <button class="btn btn-xs btn-primary" onClick={handleCreate} disabled={creating || !createName.trim()}>
            Create
          </button>
          <button class="btn btn-xs btn-ghost" onClick={() => { setShowCreate(null); setCreateName(''); }}>
            <IconX size={12} />
          </button>
        </div>
      )}

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
            <div class="fb-empty">Empty directory</div>
          )}
          {!loading && !error && items.map(item => {
            const itemPath = dirPath ? dirPath + '/' + item.name : item.name;
            const isRenaming = renameTarget?.name === item.name;

            return (
              <div
                key={item.name}
                class={`fb-row${isRenaming ? ' editing' : ''}`}
                onClick={() => !isRenaming && (item.isDirectory ? loadFiles(itemPath) : openFile(itemPath))}
              >
                <span class="fb-row-icon">
                  {item.isDirectory ? <IconFolder size={15} /> : getFileIcon(item.name, 15)}
                </span>

                {isRenaming ? (
                  <input
                    ref={renameRef}
                    class="fb-inline-input"
                    value={renameName}
                    onInput={e => setRenameName((e.target as HTMLInputElement).value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleRename();
                      if (e.key === 'Escape') { setRenameTarget(null); setRenameName(''); }
                    }}
                    onClick={e => e.stopPropagation()}
                    disabled={renaming}
                  />
                ) : (
                  <span class="fb-row-name">{item.name}</span>
                )}

                <span class="fb-row-size">{!item.isDirectory ? formatSize(item.size) : ''}</span>

                {/* Row actions */}
                {!isRenaming && (
                  <div class="fb-row-actions" onClick={e => e.stopPropagation()}>
                    <button
                      class="fb-row-btn"
                      title="Rename"
                      onClick={() => { setRenameTarget(item); setRenameName(item.name); }}
                    >
                      <IconEdit size={12} />
                    </button>
                    <button
                      class="fb-row-btn fb-row-btn-danger"
                      title="Delete"
                      onClick={() => setDeleteTarget(item)}
                    >
                      <IconTrash size={12} />
                    </button>
                  </div>
                )}

                {isRenaming && (
                  <div class="fb-row-actions" onClick={e => e.stopPropagation()}>
                    <button class="btn btn-xs btn-primary" onClick={handleRename} disabled={renaming || !renameName.trim()}>OK</button>
                    <button class="btn btn-xs btn-ghost" onClick={() => { setRenameTarget(null); setRenameName(''); }}>
                      <IconX size={11} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Delete confirmation overlay */}
      {deleteTarget && (
        <div class="fb-confirm">
          <div class="fb-confirm-box">
            <p>Delete <strong>{deleteTarget.name}</strong>?</p>
            {deleteTarget.isDirectory && (
              <label class="fb-confirm-force">
                <input type="checkbox" checked={forceDelete} onChange={e => setForceDelete((e.target as HTMLInputElement).checked)} />
                <span>Delete all contents (force)</span>
              </label>
            )}
            {deleteTarget.isDirectory && !forceDelete && <p class="fb-confirm-hint">Directory must be empty.</p>}
            <div class="fb-confirm-actions">
              <button class="btn btn-xs btn-secondary" onClick={() => { setDeleteTarget(null); setForceDelete(false); }} disabled={deleting}>Cancel</button>
              <button class="btn btn-xs btn-danger" onClick={handleDelete} disabled={deleting}>
                {deleting ? <span class="spinner-sm" /> : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Wrapped version for standalone route. */
export function FilesSection() {
  return (
    <div class="content-section">
      <FilesBrowser />
    </div>
  );
}
