import { useEffect, useState } from 'preact/hooks';
import { accountEmail, accountOrg, claudeAuthenticated, sessions, agentName, activePorts, wsConnected, dockerExperimental } from '../state/store';
import { apiFetch, getAuthToken } from '../api';
import { IconUser, IconMonitor, IconActivity, IconShield, IconHardDrive, IconDownload, IconPlug, IconPlus, IconX } from './Icons';
import { ConfirmModal } from './ConfirmModal';

interface DashboardData {
  resources: {
    cpu: { cores: number; usagePercent: number };
    memory: { used: number; limit: number; percent: number };
    disk: { used: number; total: number; percent: number };
    uptime: number;
    sessions: number;
    ports: number;
  };
  claude: {
    available: boolean;
    fiveHour: { percent: number; resetsAt: string | null } | null;
    sevenDay: { percent: number; resetsAt: string | null } | null;
  };
}

interface HomeSectionProps {
  onRelogin: () => void;
}

const PERMISSION_LABELS: Record<string, string> = {
  Read: 'Read files',
  Edit: 'Edit files',
  Write: 'Write files',
  Bash: 'Run commands',
  WebFetch: 'Fetch URLs',
  WebSearch: 'Web search',
};

const DASHBOARD_REFRESH_MS = 30_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTimeUntil(isoDate: string | null): string {
  if (!isoDate) return '';
  const diff = new Date(isoDate).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function barColor(percent: number): string {
  if (percent < 60) return 'var(--success)';
  if (percent < 80) return 'var(--warning)';
  return 'var(--error)';
}

function buildPortUrl(port: number): string | null {
  try {
    const url = new URL(`${location.protocol}//${location.hostname}:${port}`);
    return url.href;
  } catch {
    console.error(`[HomeSection] Invalid URL for port ${port}`);
    return null;
  }
}

export function HomeSection({ onRelogin }: HomeSectionProps) {
  const email = accountEmail.value;
  const org = accountOrg.value;
  const sessionCount = sessions.value.length;
  const ports = activePorts.value;
  const showRelogin = claudeAuthenticated.value && !email;
  const [exporting, setExporting] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [dashLoading, setDashLoading] = useState(true);
  const [dashError, setDashError] = useState(false);
  const [perms, setPerms] = useState<Record<string, boolean> | null>(null);
  const [networkInfo, setNetworkInfo] = useState<{ mode: string; mappedPorts: number[]; codeckPort: number } | null>(null);
  const [newPort, setNewPort] = useState('');
  const [portStatus, setPortStatus] = useState<{ type: 'success' | 'error' | 'info'; msg: string } | null>(null);
  const [addingPort, setAddingPort] = useState(false);
  const [removingPort, setRemovingPort] = useState<number | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ type: 'add' | 'remove'; port: number } | null>(null);

  const connected = wsConnected.value;

  useEffect(() => {
    loadDashboard();
    loadPermissions();
    loadNetworkInfo();
    const interval = setInterval(loadDashboard, DASHBOARD_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  // When WS reconnects after a restart, clear stale status and reload
  useEffect(() => {
    if (connected) {
      if (portStatus?.type === 'info') {
        setPortStatus({ type: 'success', msg: 'Container restarted successfully' });
        setTimeout(() => setPortStatus(null), 4000);
      }
      setAddingPort(false);
      setRemovingPort(null);
      loadNetworkInfo();
      loadDashboard();
    }
  }, [connected]);

  async function loadDashboard() {
    try {
      const res = await apiFetch('/api/dashboard');
      const data = await res.json();
      setDashboard(data);
      setDashError(false);
    } catch (e) {
      console.error('[Dashboard] Failed to load:', (e as Error).message);
      setDashError(true);
    } finally {
      setDashLoading(false);
    }
  }

  async function loadPermissions() {
    try {
      const res = await apiFetch('/api/permissions');
      setPerms(await res.json());
    } catch { /* ignore */ }
  }

  async function togglePerm(name: string) {
    if (!perms) return;
    const prev = { ...perms };
    setPerms(p => p ? { ...p, [name]: !p[name] } : p);
    try {
      const res = await apiFetch('/api/permissions', {
        method: 'POST',
        body: JSON.stringify({ [name]: !prev[name] }),
      });
      setPerms(await res.json());
    } catch { setPerms(prev); }
  }

  async function toggleAll() {
    if (!perms) return;
    const prev = { ...perms };
    const allOn = Object.values(perms).every(v => v);
    const target = !allOn;
    const updated: Record<string, boolean> = {};
    for (const key of Object.keys(perms)) updated[key] = target;
    setPerms(updated);
    try {
      const res = await apiFetch('/api/permissions', {
        method: 'POST',
        body: JSON.stringify(updated),
      });
      setPerms(await res.json());
    } catch { setPerms(prev); }
  }

  async function loadNetworkInfo() {
    try {
      const res = await apiFetch('/api/system/network-info');
      setNetworkInfo(await res.json());
    } catch { /* ignore */ }
  }

  function requestAddPort() {
    const port = parseInt(newPort, 10);
    if (!port || port < 1 || port > 65535) {
      setPortStatus({ type: 'error', msg: 'Port must be 1-65535' });
      return;
    }
    setConfirmAction({ type: 'add', port });
  }

  async function executeAddPort(port: number) {
    setAddingPort(true);
    setPortStatus(null);
    try {
      const res = await apiFetch('/api/system/add-port', {
        method: 'POST',
        body: JSON.stringify({ port }),
      });
      const data = await res.json();
      if (data.success && data.restarting) {
        setPortStatus({ type: 'info', msg: `Port ${port} added. Container restarting...` });
      } else if (data.success && data.alreadyMapped) {
        setPortStatus({ type: 'success', msg: `Port ${port} is already mapped` });
      } else if (data.success) {
        setPortStatus({ type: 'success', msg: `Port ${port} is accessible (host mode)` });
      } else if (data.requiresRestart) {
        setPortStatus({ type: 'error', msg: data.instructions });
      } else {
        setPortStatus({ type: 'error', msg: data.error || 'Unknown error' });
      }
      setNewPort('');
      loadNetworkInfo();
    } catch (e) {
      setPortStatus({ type: 'error', msg: 'Failed to add port' });
    } finally {
      setAddingPort(false);
    }
  }

  function requestRemovePort(port: number) {
    setConfirmAction({ type: 'remove', port });
  }

  async function executeRemovePort(port: number) {
    setRemovingPort(port);
    setPortStatus(null);
    try {
      const res = await apiFetch('/api/system/remove-port', {
        method: 'POST',
        body: JSON.stringify({ port }),
      });
      const data = await res.json();
      if (data.success && data.restarting) {
        setPortStatus({ type: 'info', msg: `Port ${port} removed. Container restarting...` });
      } else if (data.success && data.notMapped) {
        setPortStatus({ type: 'success', msg: `Port ${port} was not mapped` });
      } else if (data.success) {
        setPortStatus({ type: 'success', msg: `Port ${port} removed (host mode)` });
      } else if (data.requiresRestart) {
        setPortStatus({ type: 'error', msg: data.instructions });
      } else {
        setPortStatus({ type: 'error', msg: data.error || 'Unknown error' });
      }
      loadNetworkInfo();
    } catch {
      setPortStatus({ type: 'error', msg: 'Failed to remove port' });
    } finally {
      setRemovingPort(null);
    }
  }

  function handleConfirmAction() {
    if (!confirmAction) return;
    const { type, port } = confirmAction;
    setConfirmAction(null);
    if (type === 'add') executeAddPort(port);
    else executeRemovePort(port);
  }

  function handleExport() {
    setExporting(true);
    const token = getAuthToken();
    const url = `/api/workspace/export${token ? '?token=' + encodeURIComponent(token) : ''}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => setExporting(false), 3000);
  }

  return (
    <div class="content-section">
      <div class="home-content">
        {dockerExperimental.value && (
          <div class="experimental-warning" role="alert">
            <div class="experimental-warning-icon">&#9888;&#65039;</div>
            <div class="experimental-warning-text">
              <strong>Experimental Mode Active</strong>
              <p>Docker socket is mounted. The container has full access to the host Docker daemon. This removes container isolation. Only use on trusted systems.</p>
            </div>
          </div>
        )}
        <div class="home-header">
          <div class="home-title">
            <IconUser size={20} />
            <span>Account</span>
          </div>
          <div class="home-subtitle">Your Claude account information</div>
        </div>
        <div class="info-cards">
          <div class="info-card">
            <div class="info-card-label">Email</div>
            <div class={`info-card-value${!email ? ' muted' : ''}`}>
              {email || '\u2014'}
            </div>
          </div>
          <div class="info-card">
            <div class="info-card-label">Organization</div>
            <div class={`info-card-value${!org ? ' muted' : ''}`}>
              {org || '\u2014'}
            </div>
          </div>
          <div class="info-card">
            <div class="info-card-label">Status</div>
            <div class="info-card-value">
              <span class="badge badge-success">Authenticated</span>
            </div>
          </div>
          <div class="info-card">
            <div class="info-card-label">Sessions</div>
            <div class="info-card-value">{sessionCount} active</div>
          </div>
        </div>

        {showRelogin && (
          <div class="relogin-hint">
            <p>Account info not available. Re-login to retrieve your profile.</p>
            <button class="btn btn-sm btn-secondary" onClick={onRelogin}>
              Re-login for Account Info
            </button>
          </div>
        )}

        {/* Dashboard */}
        <div class="dash-section">
          <h3 class="dash-title">Dashboard</h3>

          {dashLoading && !dashboard && (
            <div class="dash-loading">
              <span class="loading" /> Loading dashboard...
            </div>
          )}

          {dashError && !dashboard && (
            <div class="dash-error">
              Failed to load dashboard data. <button class="btn btn-sm btn-secondary" onClick={loadDashboard}>Retry</button>
            </div>
          )}

          {dashboard && (
            <div class="dash-grid">
              {/* Container Resources */}
              <div class="dash-card">
                <div class="dash-card-title">
                  <IconMonitor size={14} />
                  <span>Container</span>
                </div>
                <div class="dash-bars">
                  <DashBar label="CPU" percent={dashboard.resources.cpu.usagePercent} detail={`${dashboard.resources.cpu.cores} cores`} />
                  <DashBar label="Memory" percent={dashboard.resources.memory.percent} detail={`${formatBytes(dashboard.resources.memory.used)} / ${formatBytes(dashboard.resources.memory.limit)}`} />
                  <DashBar label="Disk" percent={dashboard.resources.disk.percent} detail={`${formatBytes(dashboard.resources.disk.used)} / ${formatBytes(dashboard.resources.disk.total)}`} />
                </div>
                <div class="dash-meta">
                  Sessions: {dashboard.resources.sessions}/5 &nbsp;|&nbsp; Ports: {dashboard.resources.ports} &nbsp;|&nbsp; Uptime: {formatUptime(dashboard.resources.uptime)}
                </div>
                {ports.length > 0 && (
                  <div class="dash-ports">
                    {ports.map(p => {
                      const port = typeof p === 'object' ? p.port : p;
                      const exposed = typeof p === 'object' ? p.exposed : true;
                      const href = buildPortUrl(port);
                      if (!href) return null;
                      return (
                        <a key={port} class={`dash-port-link${exposed ? '' : ' unexposed'}`} href={href} target="_blank" rel="noopener noreferrer" title={exposed ? `Open :${port}` : `Port ${port} not mapped — may not be reachable`}>
                          :{port}
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Claude Usage */}
              <div class="dash-card">
                <div class="dash-card-title">
                  <IconActivity size={14} />
                  <span>{agentName.value} Usage</span>
                </div>
                {dashboard.claude.available ? (
                  <div class="dash-bars">
                    {dashboard.claude.fiveHour && (
                      <DashBar
                        label="5h window"
                        percent={dashboard.claude.fiveHour.percent}
                        detail={dashboard.claude.fiveHour.resetsAt ? `resets ${formatTimeUntil(dashboard.claude.fiveHour.resetsAt)}` : ''}
                      />
                    )}
                    {dashboard.claude.sevenDay && (
                      <DashBar
                        label="7d window"
                        percent={dashboard.claude.sevenDay.percent}
                        detail={dashboard.claude.sevenDay.resetsAt ? `resets ${formatTimeUntil(dashboard.claude.sevenDay.resetsAt)}` : ''}
                      />
                    )}
                  </div>
                ) : (
                  <p class="dash-unavailable">Not available — authenticate with Claude first</p>
                )}
              </div>

              {/* Permissions */}
              {perms && (() => {
                const allOn = Object.values(perms).every(v => v);
                const enabledCount = Object.values(perms).filter(v => v).length;
                const totalCount = Object.keys(perms).length;
                return (
                  <div class="dash-card">
                    <div class="dash-card-title">
                      <IconShield size={14} />
                      <span>Permissions</span>
                    </div>
                    <label class="dash-perm-toggle dash-perm-select-all">
                      <input type="checkbox" checked={allOn} onChange={toggleAll} />
                      <span>Select All</span>
                    </label>
                    <div class="dash-perms">
                      {Object.keys(perms).map(p => (
                        <label key={p} class="dash-perm-toggle">
                          <input type="checkbox" checked={perms[p]} onChange={() => togglePerm(p)} />
                          <span>{PERMISSION_LABELS[p] || p}</span>
                        </label>
                      ))}
                    </div>
                    <div class="dash-meta">
                      {allOn
                        ? 'All permissions granted'
                        : `${enabledCount}/${totalCount} enabled`}
                    </div>
                  </div>
                );
              })()}

              {/* Port Mapping */}
              {networkInfo && networkInfo.mode === 'bridge' && (
                <div class="dash-card">
                  <div class="dash-card-title">
                    <IconPlug size={14} />
                    <span>Port Mapping</span>
                  </div>
                  {networkInfo.mappedPorts.length > 0 && (
                    <div class="dash-ports">
                      {networkInfo.mappedPorts.map(p => (
                        <span key={p} class={`dash-port-tag${removingPort === p ? ' removing' : ''}`}>
                          :{p}
                          {p !== networkInfo.codeckPort && (
                            <button
                              class="dash-port-remove"
                              onClick={() => requestRemovePort(p)}
                              disabled={removingPort !== null}
                              title={`Remove port ${p}`}
                            >
                              <IconX size={10} />
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  <div class="dash-port-add">
                    <input
                      type="number"
                      class="dash-port-input"
                      placeholder="Port (e.g. 3000)"
                      value={newPort}
                      onInput={(e) => setNewPort((e.target as HTMLInputElement).value)}
                      onKeyDown={(e) => e.key === 'Enter' && requestAddPort()}
                      min="1"
                      max="65535"
                      disabled={addingPort}
                    />
                    <button class="btn btn-sm btn-primary" onClick={requestAddPort} disabled={addingPort || !newPort}>
                      {addingPort ? <span class="loading" /> : <IconPlus size={14} />}
                      Add
                    </button>
                  </div>
                  {portStatus && (
                    <div class={`dash-port-status dash-port-status-${portStatus.type}`}>
                      {portStatus.type === 'info' && <span class="loading" />}
                      {portStatus.msg}
                    </div>
                  )}
                  <div class="dash-meta">
                    Mapped ports are accessible at localhost:{'{port}'} from your browser. Adding a port restarts the container.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Workspace Export */}
        <div class="dash-section">
          <h3 class="dash-title">
            <IconHardDrive size={16} />
            <span>Workspace</span>
          </h3>
          <button class="btn btn-sm btn-secondary" onClick={handleExport} disabled={exporting}>
            {exporting ? <span class="loading" /> : <IconDownload size={14} />}
            Export workspace (.tar.gz)
          </button>
        </div>
      </div>

      {/* Confirm modal for port operations */}
      <ConfirmModal
        visible={confirmAction !== null}
        title={confirmAction?.type === 'add' ? 'Map Port to Host' : 'Remove Port Mapping'}
        message={
          confirmAction?.type === 'add'
            ? `Port ${confirmAction.port} will be mapped to the host. The container will restart (~5s), and active sessions will auto-restore.`
            : `Port ${confirmAction?.port} mapping will be removed. The container will restart (~5s), and active sessions will auto-restore.`
        }
        confirmLabel={confirmAction?.type === 'add' ? 'Map Port & Restart' : 'Remove & Restart'}
        onConfirm={handleConfirmAction}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}

function DashBar({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const p = Math.min(100, Math.max(0, Math.round(percent)));
  return (
    <div class="dash-bar-row">
      <span class="dash-bar-label">{label}</span>
      <div class="dash-bar-track">
        <div class="dash-bar-fill" style={{ width: `${p}%`, background: barColor(p) }} />
        <span class="dash-bar-percent">{p}%</span>
      </div>
      <span class="dash-bar-detail">{detail}</span>
    </div>
  );
}
