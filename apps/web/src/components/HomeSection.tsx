import { useEffect, useState } from 'preact/hooks';
import { accountEmail, claudeAuthenticated, claudeUsage, sessions, agentName, activePorts, wsConnected, dockerExperimental, setActiveSection } from '../state/store';
import { apiFetch, getAuthToken } from '../api';
import { IconUser, IconMonitor, IconX, IconDownload } from './Icons';
import { ConfirmModal } from './ConfirmModal';
import { FilesBrowser } from './FilesSection';

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

function barColor(percent: number): string {
  if (percent < 60) return 'var(--success)';
  if (percent < 80) return 'var(--warning)';
  return 'var(--error)';
}

function buildPortUrl(port: number): string | null {
  try {
    return new URL(`${location.protocol}//${location.hostname}:${port}`).href;
  } catch {
    return null;
  }
}

export function HomeSection({ onRelogin, onLogout }: HomeSectionProps) {
  const email = accountEmail.value;
  const sessionCount = sessions.value.length;
  const ports = activePorts.value;
  const showRelogin = claudeAuthenticated.value && !email;
  const usage = claudeUsage.value;
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [dashLoading, setDashLoading] = useState(true);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState(() => localStorage.getItem('codeck-welcome-dismissed') === '1');

  const connected = wsConnected.value;
  const showWelcome = !welcomeDismissed && sessionCount === 0;

  function dismissWelcome() {
    localStorage.setItem('codeck-welcome-dismissed', '1');
    setWelcomeDismissed(true);
  }

  useEffect(() => {
    loadDashboard();
    const interval = setInterval(loadDashboard, DASHBOARD_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (connected) loadDashboard();
  }, [connected]);

  async function loadDashboard() {
    try {
      const res = await apiFetch('/api/dashboard');
      setDashboard(await res.json());
    } catch { /* ignore */ }
    finally { setDashLoading(false); }
  }

  return (
    <div class="content-section">
      <div class="home-content">
        {dockerExperimental.value && (
          <div class="experimental-warning" role="alert">
            <div class="experimental-warning-icon">&#9888;&#65039;</div>
            <div class="experimental-warning-text">
              <strong>Experimental Mode Active</strong>
              <p>Docker socket is mounted. The container has full access to the host Docker daemon.</p>
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

        {/* Two cards: Account Info | VPS Info */}
        <div class="dash-grid">
          {/* Account Info */}
          <div class="dash-card">
            <div class="dash-card-title">
              <IconUser size={14} />
              <span>Account</span>
            </div>
            <div class="home-account-rows">
              <div class="home-account-row">
                <span class="home-account-label">Email</span>
                <span class={email ? '' : 'text-muted'}>{email || '\u2014'}</span>
              </div>
              <div class="home-account-row">
                <span class="home-account-label">Status</span>
                <span class="badge badge-success">Authenticated</span>
              </div>
              <div class="home-account-row">
                <span class="home-account-label">Sessions</span>
                <span>{sessionCount} active</span>
              </div>
            </div>

            {/* Usage limits — always shown */}
            <div class="home-account-limits">
              <div class="home-account-limits-title">Usage limits</div>
              {usage?.available ? (
                <>
                  {usage.fiveHour && (
                    <DashBar label="5h" percent={usage.fiveHour.percent} detail={usage.fiveHour.resetsAt ? `resets ${formatTimeUntil(usage.fiveHour.resetsAt)}` : ''} />
                  )}
                  {usage.sevenDay && (
                    <DashBar label="7d" percent={usage.sevenDay.percent} detail={usage.sevenDay.resetsAt ? `resets ${formatTimeUntil(usage.sevenDay.resetsAt)}` : ''} />
                  )}
                </>
              ) : (
                <div class="home-account-limits-loading">
                  {usage === null ? (
                    <><span class="spinner-sm" /> Loading...</>
                  ) : (
                    <span class="text-muted">Not available — usage data requires an active Claude session</span>
                  )}
                </div>
              )}
            </div>

            {showRelogin && (
              <div class="home-account-relogin">
                <p>Account info not available.</p>
                <button class="btn btn-xs btn-secondary" onClick={onRelogin}>Re-login</button>
              </div>
            )}

            <div class="home-account-disconnect">
              <button class="btn btn-xs btn-danger" onClick={() => setShowLogoutConfirm(true)}>
                Disconnect Account
              </button>
            </div>
          </div>

          {/* VPS Info */}
          <div class="dash-card">
            <div class="dash-card-title">
              <IconMonitor size={14} />
              <span>Server</span>
            </div>
            {dashLoading && !dashboard ? (
              <div class="dash-loading"><span class="spinner-sm" /> Loading...</div>
            ) : dashboard ? (
              <>
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
                        <a key={port} class={`dash-port-link${exposed ? '' : ' unexposed'}`} href={href} target="_blank" rel="noopener noreferrer" title={exposed ? `Open :${port}` : `Port ${port} not mapped`}>
                          :{port}
                        </a>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <div class="dash-meta" style="border-top: none">Failed to load server data.</div>
            )}
          </div>
        </div>

        {/* Full-width Filesystem */}
        <div class="home-filesystem">
          <FilesBrowser />
          <div class="home-export">
            <button class="btn btn-xs btn-secondary" onClick={() => {
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
            }} disabled={exporting}>
              {exporting ? <span class="spinner-sm" /> : <IconDownload size={12} />}
              Export workspace (.tar.gz)
            </button>
          </div>
        </div>
      </div>

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
