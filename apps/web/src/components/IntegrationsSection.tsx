import { useEffect, useRef, useState } from 'preact/hooks';
import { apiFetch } from '../api';
import { IconKey, IconGithub, IconPackage, IconCopy, IconCheck, IconRefresh, IconX } from './Icons';

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

export function IntegrationsSection() {
  const [ssh, setSSH] = useState<SSHStatus>({ hasKey: false, publicKey: null, authenticated: false });
  const [github, setGitHub] = useState<GitHubStatus>({ authenticated: false, loginInProgress: false, code: null, url: null, username: null, email: null, avatarUrl: null });
  const [loading, setLoading] = useState(true);
  const [sshGenerating, setSSHGenerating] = useState(false);
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
      setError('Error loading integrations status');
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
      if (data.success) {
        await loadStatus();
      } else {
        setError(data.error || 'Error generating SSH key');
      }
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
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }

  async function handleDeleteSSH() {
    if (!confirm('Delete your SSH key? You will need to generate a new one and add it to GitHub.')) return;
    setError('');
    try {
      const res = await apiFetch('/api/ssh/key', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        await loadStatus();
      } else {
        setError(data.error || 'Error deleting SSH key');
      }
    } catch {
      setError('Connection error');
    }
  }

  async function handleGitHubLogin() {
    setError('');
    try {
      const res = await apiFetch('/api/github/login', { method: 'POST' });
      const data = await res.json();
      if (data.started) {
        pollGitHubLogin();
      }
    } catch {
      setError('Error starting GitHub login');
    }
  }

  function pollGitHubLogin() {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    const MAX_POLL_DURATION = 20 * 60 * 1000; // 20 minutes — device codes typically expire in 15-30 min
    const startTime = Date.now();
    pollIntervalRef.current = setInterval(async () => {
      if (Date.now() - startTime > MAX_POLL_DURATION) {
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
      <div class="content-section">
        <div class="integ-content">
          <div class="integ-header">
            <h2 class="integ-title">Integrations</h2>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
            <span class="spinner" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div class="content-section">
      <div class="integ-content">
        <div class="integ-header">
          <h2 class="integ-title">Integrations</h2>
          <p class="integ-subtitle">Manage connections with external services</p>
        </div>

        {error && <div class="npm-error" style={{ margin: '0 0 16px' }}>{error}</div>}

        {/* GitHub SSH Card */}
        <div class="integ-card">
          <div class="integ-card-header">
            <div class="integ-card-icon"><IconKey size={20} /></div>
            <div>
              <h3 class="integ-card-title">GitHub SSH</h3>
              <p class="integ-card-desc">SSH access to GitHub repositories</p>
            </div>
            <span class={`badge ${ssh.hasKey ? (ssh.authenticated ? 'badge-success' : 'badge-warning') : 'badge-muted'}`}>
              {ssh.hasKey ? (ssh.authenticated ? 'Connected' : 'Key generated') : 'Not configured'}
            </span>
          </div>

          {!ssh.hasKey ? (
            <div class="integ-card-body">
              <p class="integ-card-info">Generate an SSH key pair to access private GitHub repositories.</p>
              <button class="btn btn-primary btn-sm" onClick={handleGenerateSSH} disabled={sshGenerating}>
                {sshGenerating ? <span class="loading" /> : <IconKey size={14} />}
                Generate SSH key
              </button>
            </div>
          ) : (
            <div class="integ-card-body">
              <div class="integ-key-block">
                <label class="npm-label">Public key:</label>
                <div class="integ-key-container">
                  <code class="integ-key-text">{ssh.publicKey || 'Loading...'}</code>
                </div>
                <div class="integ-key-actions">
                  <button class="btn btn-sm btn-secondary" onClick={handleCopyKey}>
                    {copied ? <><IconCheck size={12} /> Copied!</> : <><IconCopy size={12} /> Copy key</>}
                  </button>
                  <button class="btn btn-sm btn-ghost" onClick={() => handleGenerateSSH(true)} disabled={sshGenerating}>
                    {sshGenerating ? <span class="loading" /> : <IconRefresh size={12} />}
                    Regenerate
                  </button>
                  <button class="btn btn-sm btn-ghost" onClick={handleDeleteSSH} style={{ color: 'var(--error)' }}>
                    <IconX size={12} />
                    Delete
                  </button>
                </div>
              </div>
              <div class="integ-help">
                Add this key at{' '}
                <a href="https://github.com/settings/ssh/new" target="_blank" rel="noopener noreferrer">
                  github.com/settings/ssh/new
                </a>
              </div>
            </div>
          )}
        </div>

        {/* GitHub Account Card */}
        <div class="integ-card">
          <div class="integ-card-header">
            <div class="integ-card-icon"><IconGithub size={20} /></div>
            <div>
              <h3 class="integ-card-title">GitHub Account</h3>
              <p class="integ-card-desc">Authentication with GitHub CLI (gh)</p>
            </div>
            <span class={`badge ${github.authenticated ? 'badge-success' : 'badge-muted'}`}>
              {github.authenticated ? 'Authenticated' : 'Not connected'}
            </span>
          </div>

          <div class="integ-card-body">
            {github.loginInProgress ? (
              <div class="integ-login-flow">
                <p class="integ-card-info">
                  Open <a href={github.url || 'https://github.com/login/device'} target="_blank" rel="noopener noreferrer">
                    github.com/login/device
                  </a> and enter the code:
                </p>
                <div class="integ-device-code">{github.code || '...'}</div>
                <p class="integ-card-info" style={{ fontSize: '11px', opacity: 0.7 }}>
                  Only enter this code if you initiated this login yourself. Never share device codes received from others.
                </p>
                <div class="integ-waiting">
                  <span class="loading" /> Waiting for authentication...
                </div>
              </div>
            ) : github.authenticated ? (
              <>
                {github.username && (
                  <p class="integ-card-info" style={{ fontWeight: 500 }}>
                    @{github.username}{github.email ? ` · ${github.email}` : ''}
                  </p>
                )}
                <p class="integ-card-info">Clone private repos via HTTPS.</p>
              </>
            ) : (
              <>
                <p class="integ-card-info">Connect your GitHub account to access private repos via HTTPS.</p>
                <button class="btn btn-primary btn-sm" onClick={handleGitHubLogin}>
                  <IconGithub size={14} />
                  Connect GitHub
                </button>
              </>
            )}
          </div>
        </div>

        {/* Future integrations placeholder */}
        <div class="integ-card integ-card-placeholder">
          <div class="integ-card-header">
            <div class="integ-card-icon"><IconPackage size={20} /></div>
            <div>
              <h3 class="integ-card-title">More integrations</h3>
              <p class="integ-card-desc">GitLab, Bitbucket, Docker Hub, and more coming soon</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
