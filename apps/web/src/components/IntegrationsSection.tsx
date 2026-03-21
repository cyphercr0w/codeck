import { useEffect, useRef, useState } from 'preact/hooks';
import { apiFetch } from '../api';
import { IconKey, IconGithub, IconPackage, IconCopy, IconCheck, IconRefresh, IconX, IconChevronLeft, IconPlug } from './Icons';

// ── Types ──

interface SSHStatus {
  hasKey: boolean;
  publicKey: string | null;
  authenticated: boolean;
}

interface GitHubStatus {
  authenticated: boolean;
  loginInProgress: boolean;
  code: string | null;
  url: string | null;
  username: string | null;
  email: string | null;
  avatarUrl: string | null;
}

// ── Integration Registry ──

interface IntegrationDef {
  id: string;
  name: string;
  description: string;
  icon: () => preact.JSX.Element;
  available: boolean;
}

const INTEGRATIONS: IntegrationDef[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'SSH keys and account authentication for repositories',
    icon: () => <IconGithub size={22} />,
    available: true,
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'Connect to GitLab repositories',
    icon: () => <IconPackage size={22} />,
    available: false,
  },
  {
    id: 'docker',
    name: 'Docker Hub',
    description: 'Pull and push container images',
    icon: () => <IconPackage size={22} />,
    available: false,
  },
];

// ── GitHub Detail ──

function GitHubDetail({ onBack }: { onBack: () => void }) {
  const [ssh, setSSH] = useState<SSHStatus>({ hasKey: false, publicKey: null, authenticated: false });
  const [github, setGitHub] = useState<GitHubStatus>({ authenticated: false, loginInProgress: false, code: null, url: null, username: null, email: null, avatarUrl: null });
  const [loading, setLoading] = useState(true);
  const [sshGenerating, setSSHGenerating] = useState(false);
  const [ghConnecting, setGhConnecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadStatus();
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, []);

  async function loadStatus() {
    setLoading(true);
    setError('');
    try {
      const [sshRes, ghRes] = await Promise.all([
        apiFetch('/api/ssh/status'),
        apiFetch('/api/github/login-status'),
      ]);
      const sshData = await sshRes.json();
      const ghData = await ghRes.json();

      const sshState: SSHStatus = { hasKey: sshData.hasKey, publicKey: null, authenticated: false };
      if (sshData.hasKey) {
        try {
          const [pubRes, testRes] = await Promise.all([
            apiFetch('/api/ssh/public-key'),
            apiFetch('/api/ssh/test'),
          ]);
          const pubData = await pubRes.json();
          const testData = await testRes.json();
          sshState.publicKey = pubData.publicKey || null;
          sshState.authenticated = testData.authenticated || false;
        } catch { /* ignore */ }
      }

      setSSH(sshState);
      setGitHub({
        authenticated: ghData.authenticated || false,
        loginInProgress: ghData.inProgress || false,
        code: ghData.code || null,
        url: ghData.url || null,
        username: ghData.username || null,
        email: ghData.email || null,
        avatarUrl: ghData.avatarUrl || null,
      });
    } catch {
      setError('Error loading status');
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerateSSH(force = false) {
    setSSHGenerating(true);
    setError('');
    try {
      const res = await apiFetch('/api/ssh/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const data = await res.json();
      if (data.success) await loadStatus();
      else setError(data.error || 'Error generating SSH key');
    } catch {
      setError('Connection error');
    } finally {
      setSSHGenerating(false);
    }
  }

  async function handleCopyKey() {
    if (!ssh.publicKey) return;
    try {
      await navigator.clipboard.writeText(ssh.publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const el = document.querySelector('.integ-key-text') as HTMLElement;
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
    }
  }

  async function handleDeleteSSH() {
    if (!confirm('Delete your SSH key? You will need to generate a new one.')) return;
    setError('');
    try {
      const res = await apiFetch('/api/ssh/key', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) await loadStatus();
      else setError(data.error || 'Error deleting SSH key');
    } catch {
      setError('Connection error');
    }
  }

  async function handleGitHubLogin() {
    setError('');
    setGhConnecting(true);
    try {
      const res = await apiFetch('/api/github/login', { method: 'POST' });
      const data = await res.json();
      if (data.started) {
        pollGitHubLogin();
        // Stay in connecting state — poll will update github state which re-renders
      } else {
        setGhConnecting(false);
      }
    } catch {
      setError('Error starting GitHub login');
      setGhConnecting(false);
    }
  }

  function pollGitHubLogin() {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    const startTime = Date.now();
    pollIntervalRef.current = setInterval(async () => {
      if (Date.now() - startTime > 20 * 60 * 1000) {
        clearInterval(pollIntervalRef.current!);
        pollIntervalRef.current = null;
        setGitHub(prev => ({ ...prev, loginInProgress: false }));
        setError('Login timed out. Please try again.');
        return;
      }
      try {
        const res = await apiFetch('/api/github/login-status');
        const data = await res.json();
        setGitHub({
          authenticated: data.authenticated || false,
          loginInProgress: data.inProgress || false,
          code: data.code || null,
          url: data.url || null,
          username: data.username || null,
          email: data.email || null,
          avatarUrl: data.avatarUrl || null,
        });
        // Clear connecting spinner once device code arrives or login completes
        if (data.code || !data.inProgress) setGhConnecting(false);
        if (!data.inProgress) {
          clearInterval(pollIntervalRef.current!);
          pollIntervalRef.current = null;
        }
      } catch {
        clearInterval(pollIntervalRef.current!);
        pollIntervalRef.current = null;
      }
    }, 2000);
  }

  if (loading) {
    return (
      <div class="integ-detail">
        <button class="btn btn-xs btn-ghost" onClick={onBack} style="margin-bottom: 16px">
          <IconChevronLeft size={14} /> Back
        </button>
        <div style="display: flex; justify-content: center; padding: 48px">
          <span class="spinner-lg" />
        </div>
      </div>
    );
  }

  return (
    <div class="integ-detail">
      <button class="btn btn-xs btn-ghost" onClick={onBack} style="margin-bottom: 16px">
        <IconChevronLeft size={14} /> Integrations
      </button>

      <div class="integ-detail-header">
        <IconGithub size={24} />
        <div>
          <h2 class="integ-detail-title">GitHub</h2>
          <p class="integ-detail-desc">Connect to GitHub repositories via SSH or HTTPS</p>
        </div>
      </div>

      {error && <div class="integ-error">{error}</div>}

      {/* SSH Section */}
      <div class="integ-section">
        <div class="integ-section-header">
          <IconKey size={14} />
          <span>Connect via SSH</span>
          <span class={`badge ${ssh.hasKey ? (ssh.authenticated ? 'badge-success' : 'badge-warning') : 'badge-muted'}`}>
            {ssh.hasKey ? (ssh.authenticated ? 'Connected' : 'Key generated') : 'Not configured'}
          </span>
        </div>

        <div class="integ-section-body">
          {!ssh.hasKey ? (
            <>
              <p class="integ-section-info">Generate an SSH key pair to access private repositories via git@github.com.</p>
              <button class="btn btn-sm btn-primary" onClick={() => handleGenerateSSH()} disabled={sshGenerating}>
                {sshGenerating ? <span class="spinner-sm" /> : <IconKey size={13} />}
                Generate SSH key
              </button>
            </>
          ) : (
            <>
              <div class="integ-key-block">
                <label class="integ-key-label">Public key</label>
                <div class="integ-key-container">
                  <code class="integ-key-text">{ssh.publicKey || 'Loading...'}</code>
                </div>
                <div class="integ-key-actions">
                  <button class="btn btn-xs btn-secondary" onClick={handleCopyKey}>
                    {copied ? <><IconCheck size={11} /> Copied</> : <><IconCopy size={11} /> Copy</>}
                  </button>
                  <button class="btn btn-xs btn-ghost" onClick={() => handleGenerateSSH(true)} disabled={sshGenerating}>
                    {sshGenerating ? <span class="spinner-sm" /> : <IconRefresh size={11} />}
                    Regenerate
                  </button>
                  <button class="btn btn-xs btn-ghost danger" onClick={handleDeleteSSH}>
                    <IconX size={11} /> Delete
                  </button>
                </div>
              </div>
              <p class="integ-section-hint">
                Add this key at{' '}
                <a href="https://github.com/settings/ssh/new" target="_blank" rel="noopener noreferrer">
                  github.com/settings/ssh/new
                </a>
              </p>
            </>
          )}
        </div>
      </div>

      {/* HTTPS Section */}
      <div class="integ-section">
        <div class="integ-section-header">
          <IconGithub size={14} />
          <span>Connect via HTTPS</span>
          <span class={`badge ${github.authenticated ? 'badge-success' : 'badge-muted'}`}>
            {github.authenticated ? 'Authenticated' : 'Not connected'}
          </span>
        </div>

        <div class="integ-section-body">
          {github.loginInProgress ? (
            <div class="integ-login-flow">
              <p class="integ-section-info">
                Open{' '}
                <a href={github.url || 'https://github.com/login/device'} target="_blank" rel="noopener noreferrer">
                  github.com/login/device
                </a>{' '}
                and enter the code:
              </p>
              <div class="integ-device-code">{github.code || '...'}</div>
              <p class="integ-section-hint">
                Only enter this code if you initiated this login yourself.
              </p>
              <div class="integ-waiting">
                <span class="spinner-sm" /> Waiting for authentication...
              </div>
            </div>
          ) : github.authenticated ? (
            <div class="integ-connected-info">
              {github.username && (
                <span class="integ-username">@{github.username}</span>
              )}
              {github.email && (
                <span class="integ-email">{github.email}</span>
              )}
              <p class="integ-section-hint">Clone private repos via HTTPS using GitHub CLI.</p>
            </div>
          ) : (
            <>
              <p class="integ-section-info">Connect your GitHub account to access private repos via HTTPS.</p>
              <button class="btn btn-sm btn-primary" onClick={handleGitHubLogin} disabled={ghConnecting}>
                {ghConnecting ? <span class="spinner-sm" /> : <IconGithub size={13} />}
                {ghConnecting ? 'Connecting...' : 'Connect GitHub'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ──

export function IntegrationsSection() {
  const [selected, setSelected] = useState<string | null>(null);
  const [ghAuth, setGhAuth] = useState(false);

  useEffect(() => {
    apiFetch('/api/github/login-status')
      .then(r => r.json())
      .then(d => setGhAuth(d.authenticated || false))
      .catch(() => {});
  }, [selected]); // re-check when returning from detail view

  if (selected === 'github') {
    return (
      <div class="content-section">
        <div class="integ-content">
          <GitHubDetail onBack={() => setSelected(null)} />
        </div>
      </div>
    );
  }

  return (
    <div class="content-section">
      <div class="integ-content">
        <div class="integ-header">
          <h2 class="integ-title">
            <IconPlug size={20} />
            Integrations
          </h2>
          <p class="integ-subtitle">Connect external services to your workspace</p>
        </div>

        <div class="integ-grid">
          {INTEGRATIONS.map(integ => (
            <button
              key={integ.id}
              class={`integ-tile${!integ.available ? ' disabled' : ''}`}
              onClick={() => integ.available && setSelected(integ.id)}
              disabled={!integ.available}
            >
              <div class="integ-tile-icon">{integ.icon()}</div>
              <div class="integ-tile-info">
                <span class="integ-tile-name">{integ.name}</span>
                <span class="integ-tile-desc">{integ.description}</span>
              </div>
              {!integ.available && <span class="badge badge-muted">Coming soon</span>}
              {integ.id === 'github' && ghAuth && <span class="badge badge-success">Connected</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
