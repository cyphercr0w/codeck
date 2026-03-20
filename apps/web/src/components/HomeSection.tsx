import { useEffect, useState } from 'preact/hooks';
import { accountEmail, accountOrg, claudeAuthenticated, sessions, agentName, activePorts, wsConnected, dockerExperimental, setActiveSection } from '../state/store';
import { apiFetch, getAuthToken } from '../api';
import { IconUser, IconMonitor, IconActivity, IconHardDrive, IconDownload, IconPlus, IconX, IconBrain } from './Icons';
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

interface MemoryStats {
  sessionsRemembered: number;
  totalMemoryKB: number;
  durableMemoryLines: number;
  dailyLogCount: number;
  decisionsCount: number;
  projectsTracked: number;
  lastActivityAt: number | null;
}

interface HomeSectionProps {
  onRelogin: () => void;
  onLogout: () => void;
}


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

function formatTimeAgo(timestamp: number | null): string {
  if (!timestamp) return 'Never';
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'Just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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

export function HomeSection({ onRelogin, onLogout }: HomeSectionProps) {
  const email = accountEmail.value;
  const org = accountOrg.value;
  const sessionCount = sessions.value.length;
  const ports = activePorts.value;
  const showRelogin = claudeAuthenticated.value && !email;
  const [exporting, setExporting] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [dashLoading, setDashLoading] = useState(true);
  const [dashError, setDashError] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [memoryStats, setMemoryStats] = useState<MemoryStats | null>(null);
  const [welcomeDismissed, setWelcomeDismissed] = useState(() => localStorage.getItem('codeck-welcome-dismissed') === '1');

  const connected = wsConnected.value;

  const showWelcome = !welcomeDismissed && sessionCount === 0 && memoryStats !== null && memoryStats.sessionsRemembered === 0;

  function dismissWelcome() {
    localStorage.setItem('codeck-welcome-dismissed', '1');
    setWelcomeDismissed(true);
  }

  useEffect(() => {
    loadDashboard();
    loadMemoryStats();
    const interval = setInterval(() => { loadDashboard(); loadMemoryStats(); }, DASHBOARD_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  // When WS reconnects after a restart, reload dashboard
  useEffect(() => {
    if (connected) {
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

  async function loadMemoryStats() {
    try {
      const res = await apiFetch('/api/dashboard/memory-stats');
      setMemoryStats(await res.json());
    } catch { /* ignore — card just won't show */ }
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

        {showWelcome && (
          <div class="welcome-card">
            <button class="welcome-dismiss" onClick={dismissWelcome} title="Dismiss">
              <IconX size={14} />
            </button>
            <h2 class="welcome-title">Welcome to Codeck</h2>
            <p class="welcome-subtitle">Your AI coding agent with persistent memory</p>
            <ul class="welcome-features">
              <li>
                <span class="welcome-feature-icon" aria-hidden="true">&#129504;</span>
                <span><strong>Agent Memory</strong> — Claude remembers your projects, preferences, and decisions across sessions</span>
              </li>
              <li>
                <span class="welcome-feature-icon" aria-hidden="true">&#128421;&#65039;</span>
                <span><strong>Always On</strong> — Your machine runs 24/7, accessible from any device</span>
              </li>
              <li>
                <span class="welcome-feature-icon" aria-hidden="true">&#9889;</span>
                <span><strong>Skills &amp; Agents</strong> — Pre-loaded knowledge packs and sub-agents that make Claude smarter</span>
              </li>
            </ul>
            <button class="btn btn-primary welcome-cta" onClick={() => { setActiveSection('claude'); history.pushState(null, '', '/claude'); }}>
              Start your first session →
            </button>
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

        <div style={{ marginTop: '12px' }}>
          <button class="btn btn-sm btn-danger" onClick={() => setShowLogoutConfirm(true)}>
            Disconnect Account
          </button>
          <span class="dash-meta" style={{ marginLeft: '8px' }}>
            Clears auth tokens. Workspace data is kept.
          </span>
        </div>

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

              {/* Agent Memory */}
              {memoryStats && (
                <div class="dash-card">
                  <div class="dash-card-title">
                    <IconBrain size={14} />
                    <span>Agent Memory</span>
                  </div>
                  <div class="dash-memory-stats">
                    <div class="dash-memory-stat">
                      <span class="dash-memory-stat-value">{memoryStats.sessionsRemembered}</span>
                      <span class="dash-memory-stat-label">sessions remembered</span>
                    </div>
                    <div class="dash-memory-stat">
                      <span class="dash-memory-stat-value">{memoryStats.projectsTracked}</span>
                      <span class="dash-memory-stat-label">projects tracked</span>
                    </div>
                    <div class="dash-memory-stat">
                      <span class="dash-memory-stat-value">{memoryStats.decisionsCount}</span>
                      <span class="dash-memory-stat-label">decisions recorded</span>
                    </div>
                    <div class="dash-memory-stat">
                      <span class="dash-memory-stat-value">{memoryStats.dailyLogCount}</span>
                      <span class="dash-memory-stat-label">daily logs</span>
                    </div>
                  </div>
                  <div class="dash-meta">
                    Last active: {formatTimeAgo(memoryStats.lastActivityAt)} &nbsp;|&nbsp; {memoryStats.totalMemoryKB} KB total
                  </div>
                  <div class="dash-memory-status">
                    <span class="dash-memory-dot" />
                    <span>Memory active</span>
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

      {/* Confirm modal for account disconnect */}
      <ConfirmModal
        visible={showLogoutConfirm}
        title="Disconnect Claude Account"
        message={`This will clear all OAuth tokens and sign you out of Claude.${sessionCount > 0 ? ` ${sessionCount} active session(s) will lose authentication.` : ''} Your workspace files, memory, and settings are kept.`}
        confirmLabel="Disconnect"
        onConfirm={() => { setShowLogoutConfirm(false); onLogout(); }}
        onCancel={() => setShowLogoutConfirm(false)}
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
