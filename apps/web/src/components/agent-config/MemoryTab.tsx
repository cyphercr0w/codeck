import { useEffect, useRef, useState } from 'preact/hooks';
import { apiFetch, getAuthToken } from '../../api';
import { showToast } from '../../state/store';
import { IconBrain, IconFolder, IconDownload, IconPlus, IconRefresh, IconBookmark, IconPlug, IconList, IconShield, IconSettings, IconKey } from '../Icons';
import { ConfirmModal } from '../ConfirmModal';

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

interface MemoryTabProps {
  onNavigate?: (tab: 'memory' | 'skills' | 'mcp' | 'rules' | 'hooks' | 'permissions' | 'env') => void;
}

export function MemoryTab({ onNavigate }: MemoryTabProps) {
  const [memStats, setMemStats] = useState<MemoryStats | null>(null);
  const [presetStatus, setPresetStatus] = useState<PresetStatus | null>(null);

  // Preset actions
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Migration
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadMemoryStats();
    loadPresetStatus();
  }, []);

  async function loadMemoryStats() {
    try {
      const res = await apiFetch('/api/dashboard/memory-stats');
      setMemStats(await res.json());
    } catch { /* non-fatal */ }
  }

  async function loadPresetStatus() {
    try {
      const res = await apiFetch('/api/presets/status');
      setPresetStatus(await res.json());
    } catch { /* non-fatal */ }
  }

  async function handleUpdate() {
    setUpdating(true);
    setShowUpdateModal(false);
    try {
      const res = await apiFetch('/api/presets/update', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('Preset updated', 'success');
        loadPresetStatus();
      } else {
        showToast(data.error || 'Update failed', 'error');
      }
    } catch {
      showToast('Update failed', 'error');
    }
    setUpdating(false);
  }

  async function handleReset() {
    setResetting(true);
    setShowResetModal(false);
    try {
      const res = await apiFetch('/api/presets/reset', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('Factory defaults restored', 'success');
        loadMemoryStats();
        loadPresetStatus();
      } else {
        showToast(data.error || 'Reset failed', 'error');
      }
    } catch {
      showToast('Reset failed', 'error');
    }
    setResetting(false);
  }

  function handleExport() {
    setExporting(true);
    const token = getAuthToken();
    const url = `/api/codeck/export${token ? '?token=' + encodeURIComponent(token) : ''}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => setExporting(false), 2000);
  }

  function handleImportSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.tar.gz') && !file.name.endsWith('.tgz')) {
      showToast('File must be a .tar.gz archive', 'error');
      return;
    }
    setImportFile(file);
    setShowImportConfirm(true);
    input.value = '';
  }

  async function handleImportConfirm() {
    if (!importFile) return;
    setShowImportConfirm(false);
    setImporting(true);

    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(importFile);
      });

      const res = await apiFetch('/api/codeck/import', {
        method: 'POST',
        body: JSON.stringify({ data: base64 }),
      });
      if (res.status === 413) {
        showToast('File too large — if using nginx, add "client_max_body_size 100m;" to your server config and reload nginx.', 'error');
      } else {
        const data = await res.json();
        if (data.success) {
          showToast(`Memory imported — ${data.imported} items restored`, 'success');
          loadMemoryStats();
        } else {
          showToast(data.error || 'Import failed', 'error');
        }
      }
    } catch (err) {
      const errMsg = (err as Error).message || '';
      if (errMsg.includes('NetworkError') || errMsg.includes('Failed to fetch')) {
        showToast('Upload failed — file may be too large for your reverse proxy.', 'error');
      } else {
        showToast('Import failed: ' + errMsg, 'error');
      }
    }
    setImporting(false);
    setImportFile(null);
  }

  const hasUpdate = presetStatus?.updateAvailable ?? false;

  return (
    <div class="ac-tab-content">
      {/* Memory Stats */}
      <div class="ac-section">
        <div class="ac-section-header">
          <div class="ac-section-title"><IconBrain size={14} /> Agent Memory</div>
          <button class="btn btn-xs btn-ghost" onClick={loadMemoryStats} title="Refresh">
            <IconRefresh size={13} />
          </button>
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
              <span class="mem-stat-value">{memStats.totalMemoryKB >= 1024 ? `${(memStats.totalMemoryKB / 1024).toFixed(1)} MB` : `${memStats.totalMemoryKB} KB`}</span>
              <span class="mem-stat-label">total size</span>
            </div>
          </div>
        ) : (
          <div class="ac-empty"><span class="spinner-sm" /> Loading...</div>
        )}
        {memStats && (
          <div class="dash-meta" style="margin-top: 8px">
            Last active: {formatTimeAgo(memStats.lastActivityAt)}
          </div>
        )}
      </div>

      {/* Preset + Migration side by side on desktop */}
      <div class="ac-row">
      {presetStatus?.configured && (
        <div class="ac-section" style="flex: 1; min-width: 0">
          <div class="ac-section-title"><IconFolder size={14} /> Preset</div>
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
          </div>
        </div>
      )}

      {/* Migration */}
      <div class="ac-section" style="flex: 1; min-width: 0; border-left: 1px solid var(--border); padding-left: 20px">
        <div class="ac-section-title">Memory Migration</div>
        <div class="ac-migration-actions">
          <button class="btn btn-xs btn-secondary" onClick={handleExport} disabled={exporting}>
            {exporting ? <span class="spinner-sm" /> : <IconDownload size={12} />}
            Export memory
          </button>
          <button class="btn btn-xs btn-secondary" onClick={() => importInputRef.current?.click()} disabled={importing}>
            {importing ? <span class="spinner-sm" /> : <IconPlus size={12} />}
            Import memory
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".tar.gz,.tgz"
            style="display: none"
            onChange={handleImportSelect}
          />
        </div>
        <div class="ac-hint">
          Export downloads all memory, preferences, rules, and skills as a .tar.gz archive.
        </div>
      </div>
      </div>{/* close ac-row */}

      {/* Quick Access Shortcuts */}
      {onNavigate && (
        <div class="ac-section">
          <div class="ac-section-title">Configuration</div>
          <div class="mem-shortcuts">
            <button class="mem-shortcut" onClick={() => onNavigate('skills')}>
              <IconBookmark size={16} />
              <div>
                <div class="mem-shortcut-title">Skills</div>
                <div class="mem-shortcut-desc">Manage agent capabilities</div>
              </div>
            </button>
            <button class="mem-shortcut" onClick={() => onNavigate('mcp')}>
              <IconPlug size={16} />
              <div>
                <div class="mem-shortcut-title">MCP Servers</div>
                <div class="mem-shortcut-desc">External tool integrations</div>
              </div>
            </button>
            <button class="mem-shortcut" onClick={() => onNavigate('rules')}>
              <IconList size={16} />
              <div>
                <div class="mem-shortcut-title">Rules</div>
                <div class="mem-shortcut-desc">Coding standards & guidelines</div>
              </div>
            </button>
            <button class="mem-shortcut" onClick={() => onNavigate('hooks')}>
              <IconSettings size={16} />
              <div>
                <div class="mem-shortcut-title">Hooks</div>
                <div class="mem-shortcut-desc">Automation scripts</div>
              </div>
            </button>
            <button class="mem-shortcut" onClick={() => onNavigate('permissions')}>
              <IconShield size={16} />
              <div>
                <div class="mem-shortcut-title">Permissions</div>
                <div class="mem-shortcut-desc">Tool access controls</div>
              </div>
            </button>
            <button class="mem-shortcut" onClick={() => onNavigate('env')}>
              <IconKey size={16} />
              <div>
                <div class="mem-shortcut-title">Environment</div>
                <div class="mem-shortcut-desc">Variables & secrets</div>
              </div>
            </button>
          </div>
        </div>
      )}

      <ConfirmModal
        visible={showImportConfirm}
        title="Import Memory"
        message={`This will replace your current memory with "${importFile?.name || 'archive'}". Auth config and sessions will NOT be affected.`}
        confirmLabel="Import & Replace"
        onConfirm={handleImportConfirm}
        onCancel={() => { setShowImportConfirm(false); setImportFile(null); }}
      />
      <ConfirmModal
        visible={showUpdateModal}
        title="Update Preset"
        message="This will update scripts, hooks, skills, and CLAUDE.md to the latest version. Memory and preferences will NOT be touched."
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
    </div>
  );
}
