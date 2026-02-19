import { useEffect, useRef, useState } from 'preact/hooks';
import { apiFetch } from '../api';
import { workspacePath, agentName } from '../state/store';
import { IconFolder, IconPlus, IconGithub } from './Icons';

type Tab = 'existing' | 'create' | 'clone';

interface LaunchOptions {
  resume: boolean;
}

interface NewProjectModalProps {
  visible: boolean;
  onCancel: () => void;
  onConfirm: (dir: string, options: LaunchOptions) => void;
}

export function NewProjectModal({ visible, onCancel, onConfirm }: NewProjectModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>('existing');
  const [dirs, setDirs] = useState<string[]>([]);
  const ws = workspacePath.value;
  const [selected, setSelected] = useState(ws);
  const [newName, setNewName] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [cloneBranch, setCloneBranch] = useState('');
  const [resume, setResume] = useState(false);
  const [canResume, setCanResume] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sshConfigured, setSshConfigured] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (visible) {
      setTab('existing');
      setSelected(ws);
      setNewName('');
      setCloneUrl('');
      setCloneName('');
      setCloneBranch('');
      setResume(false);
      setCanResume(false);
      setLoading(false);
      setError('');
      loadDirs();
      checkSshStatus();
      checkConversations(ws);

      // Focus trap and Escape handler
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') { onCancel(); return; }
        if (e.key === 'Tab') {
          const focusableEls = modalRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
          );
          if (!focusableEls || focusableEls.length === 0) return;
          const firstEl = focusableEls[0];
          const lastEl = focusableEls[focusableEls.length - 1];
          if (e.shiftKey && document.activeElement === firstEl) {
            e.preventDefault();
            lastEl.focus();
          } else if (!e.shiftKey && document.activeElement === lastEl) {
            e.preventDefault();
            firstEl.focus();
          }
        }
      };
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [visible, onCancel]);

  useEffect(() => {
    if (tab === 'create') nameRef.current?.focus();
    if (tab === 'clone') urlRef.current?.focus();
  }, [tab]);

  async function loadDirs() {
    setDirs([]);
    try {
      const res = await apiFetch('/api/files?path=');
      const data = await res.json();
      if (data.success) {
        const subdirs = data.items
          .filter((i: { isDirectory: boolean }) => i.isDirectory)
          .map((i: { name: string }) => ws + '/' + i.name);
        setDirs(subdirs);
      }
    } catch { /* ignore */ }
  }

  async function checkConversations(cwd: string) {
    try {
      const res = await apiFetch(`/api/console/has-conversations?cwd=${encodeURIComponent(cwd)}`);
      const data = await res.json();
      setCanResume(!!data.hasConversations);
      if (!data.hasConversations) setResume(false);
    } catch {
      setCanResume(false);
      setResume(false);
    }
  }

  function selectDir(dir: string) {
    setSelected(dir);
    checkConversations(dir);
  }

  async function checkSshStatus() {
    try {
      const res = await apiFetch('/api/ssh/status');
      const data = await res.json();
      setSshConfigured(data.hasKey);
    } catch { /* ignore */ }
  }

  function isSSHUrl(url: string): boolean {
    return url.startsWith('git@') || url.includes('ssh://');
  }

  async function handleCreateFolder() {
    const name = newName.trim();
    if (!name) return;

    setError('');
    setLoading(true);
    try {
      const res = await apiFetch('/api/projects/create', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (data.success) {
        onConfirm(data.path, { resume });
      } else {
        setError(data.error || 'Error creating folder');
      }
    } catch {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  }

  async function handleClone() {
    const url = cloneUrl.trim();
    if (!url) return;

    setError('');
    setLoading(true);
    try {
      const body: Record<string, string> = { url };
      if (cloneName.trim()) body.name = cloneName.trim();
      if (cloneBranch.trim()) body.branch = cloneBranch.trim();

      const res = await apiFetch('/api/projects/clone', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        onConfirm(data.path, { resume });
      } else {
        setError(data.error || 'Error cloning');
      }
    } catch {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  }

  function handleConfirm() {
    if (tab === 'existing') {
      onConfirm(selected, { resume });
    } else if (tab === 'create') {
      handleCreateFolder();
    } else {
      handleClone();
    }
  }

  function canConfirm(): boolean {
    if (loading) return false;
    if (tab === 'existing') return true;
    if (tab === 'create') return newName.trim().length > 0;
    if (tab === 'clone') return cloneUrl.trim().length > 0;
    return false;
  }

  if (!visible) return null;

  return (
    <div class="modal-overlay" onClick={onCancel}>
      <div
        ref={modalRef}
        class="modal"
        style={{ maxWidth: '480px' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="npm-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="npm-modal-title" class="modal-title">New {agentName.value} session</h2>

        {/* Tabs */}
        <div class="npm-tabs" role="tablist" aria-label="Session type">
          <button class={`npm-tab${tab === 'existing' ? ' active' : ''}`} role="tab" aria-selected={tab === 'existing'} onClick={() => { setTab('existing'); setError(''); }}>
            <IconFolder size={14} />
            Existing folder
          </button>
          <button class={`npm-tab${tab === 'create' ? ' active' : ''}`} role="tab" aria-selected={tab === 'create'} onClick={() => { setTab('create'); setError(''); setResume(false); }}>
            <IconPlus size={14} />
            New folder
          </button>
          <button class={`npm-tab${tab === 'clone' ? ' active' : ''}`} role="tab" aria-selected={tab === 'clone'} onClick={() => { setTab('clone'); setError(''); setResume(false); }}>
            <IconGithub size={14} />
            Clone repo
          </button>
        </div>

        {/* Tab content */}
        <div class="npm-content">
          {tab === 'existing' && (
            <div class="dir-list">
              <div
                class={`dir-item${selected === ws ? ' selected' : ''}`}
                onClick={() => selectDir(ws)}
              >
                <IconFolder size={14} />
                <span>{ws} (default)</span>
              </div>
              {dirs.map(d => (
                <div
                  key={d}
                  class={`dir-item${selected === d ? ' selected' : ''}`}
                  onClick={() => selectDir(d)}
                >
                  <IconFolder size={14} />
                  <span>{d.split('/').pop()}</span>
                </div>
              ))}
            </div>
          )}

          {tab === 'create' && (
            <div class="npm-form">
              <label class="npm-label">Folder name</label>
              <input
                ref={nameRef}
                type="text"
                class="input"
                placeholder="my-project"
                value={newName}
                onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && canConfirm()) handleConfirm(); }}
              />
              <p class="npm-hint">Will be created in {ws}/{newName.trim() || '...'}</p>
            </div>
          )}

          {tab === 'clone' && (
            <div class="npm-form">
              <label class="npm-label">Repository URL</label>
              <input
                ref={urlRef}
                type="text"
                class="input"
                placeholder="https://github.com/user/repo.git"
                value={cloneUrl}
                onInput={(e) => setCloneUrl((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && canConfirm()) handleConfirm(); }}
              />

              {/* SSH warning */}
              {cloneUrl && isSSHUrl(cloneUrl) && !sshConfigured && (
                <div class="npm-warning">
                  SSH keys not configured. Private repos will fail. Configure them in Integrations.
                </div>
              )}

              <div class="npm-row">
                <div style={{ flex: 1 }}>
                  <label class="npm-label">Name (optional)</label>
                  <input
                    type="text"
                    class="input"
                    placeholder="auto-detected"
                    value={cloneName}
                    onInput={(e) => setCloneName((e.target as HTMLInputElement).value)}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label class="npm-label">Branch (optional)</label>
                  <input
                    type="text"
                    class="input"
                    placeholder="default"
                    value={cloneBranch}
                    onInput={(e) => setCloneBranch((e.target as HTMLInputElement).value)}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Launch options — only show when resume is available */}
        {tab === 'existing' && canResume && (
          <div class="npm-launch-options">
            <div class="npm-launch-title">Launch options</div>
            <label class="npm-checkbox">
              <input type="checkbox" checked={resume} onChange={(e) => setResume((e.target as HTMLInputElement).checked)} />
              <span>Resume previous conversation</span>
              <span class="npm-flag">--resume</span>
            </label>
          </div>
        )}

        {error && <div class="npm-error" role="alert">{error}</div>}

        <div class="modal-actions">
          <button class="btn btn-secondary" onClick={onCancel} disabled={loading}>Cancel</button>
          <button class="btn btn-primary" onClick={handleConfirm} disabled={!canConfirm()}>
            {loading ? <span class="loading" /> : null}
            {tab === 'clone' ? 'Clone and open' : 'Open terminal'}
          </button>
        </div>
      </div>
    </div>
  );
}
