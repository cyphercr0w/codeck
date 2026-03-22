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
  // For token-based integrations
  tokenBased?: boolean;
  tokenEnvKey?: string;
  tokenUrl?: string;
  tokenHint?: string;
  mcpServerName?: string;
}

const INTEGRATIONS: IntegrationDef[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repos, PRs, issues, and code search',
    icon: () => <IconGithub size={22} />,
    available: true,
    mcpServerName: 'github',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Database, auth, storage, and edge functions',
    icon: () => <IconPackage size={22} />,
    available: true,
    tokenBased: true,
    tokenEnvKey: 'SUPABASE_ACCESS_TOKEN',
    tokenUrl: 'https://supabase.com/dashboard/account/tokens',
    tokenHint: 'Generate a token at supabase.com → Account → Access Tokens',
    mcpServerName: 'supabase',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: 'Deployments, projects, and domains',
    icon: () => <IconPackage size={22} />,
    available: true,
    tokenBased: true,
    tokenEnvKey: 'VERCEL_TOKEN',
    tokenUrl: 'https://vercel.com/account/tokens',
    tokenHint: 'Generate a token at vercel.com → Account → Tokens',
    mcpServerName: 'vercel',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Payments, subscriptions, and invoices',
    icon: () => <IconPackage size={22} />,
    available: true,
    tokenBased: true,
    tokenEnvKey: 'STRIPE_SECRET_KEY',
    tokenUrl: 'https://dashboard.stripe.com/apikeys',
    tokenHint: 'Copy your Secret Key from the Stripe Dashboard → API Keys',
    mcpServerName: 'stripe',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Pages, databases, and workspaces',
    icon: () => <IconPackage size={22} />,
    available: true,
    tokenBased: true,
    tokenEnvKey: 'NOTION_API_KEY',
    tokenUrl: 'https://www.notion.so/my-integrations',
    tokenHint: 'Create an integration at notion.so/my-integrations and copy the secret',
    mcpServerName: 'notion',
  },
  {
    id: 'google',
    name: 'Google (Gmail, Drive, Sheets)',
    description: 'Email, documents, spreadsheets, and calendar',
    icon: () => <IconPackage size={22} />,
    available: true,
    tokenBased: true,
    tokenEnvKey: 'GOOGLE_API_KEY',
    tokenUrl: 'https://console.cloud.google.com/apis/credentials',
    tokenHint: 'Create an API key or Service Account at Google Cloud Console → APIs & Services → Credentials',
    mcpServerName: 'google',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'DNS, Workers, Pages, and CDN',
    icon: () => <IconPackage size={22} />,
    available: true,
    tokenBased: true,
    tokenEnvKey: 'CLOUDFLARE_API_TOKEN',
    tokenUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    tokenHint: 'Create an API token at Cloudflare Dashboard → Profile → API Tokens',
    mcpServerName: 'cloudflare',
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Design files, components, and styles',
    icon: () => <IconPackage size={22} />,
    available: true,
    tokenBased: true,
    tokenEnvKey: 'FIGMA_ACCESS_TOKEN',
    tokenUrl: 'https://www.figma.com/developers/api#access-tokens',
    tokenHint: 'Generate a personal access token at Figma → Settings → Personal Access Tokens',
    mcpServerName: 'figma',
  },
];

// ── Token-Based Integration Detail ──

function TokenIntegrationDetail({ integ, onBack }: { integ: IntegrationDef; onBack: () => void }) {
  const [token, setToken] = useState('');
  const [connected, setConnected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [checking, setChecking] = useState(true);

  // Check if already connected (env var exists)
  useEffect(() => {
    setChecking(true);
    apiFetch('/api/codeck/env')
      .then(r => r.json())
      .then(data => {
        const vars = data.vars || [];
        setConnected(vars.some((v: { key: string; hasValue: boolean }) => v.key === integ.tokenEnvKey && v.hasValue));
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  async function handleConnect() {
    if (!token.trim()) return;
    setSaving(true);
    setMsg(null);
    try {
      // Save token as env var
      const envRes = await apiFetch('/api/codeck/env', {
        method: 'POST',
        body: JSON.stringify({ key: integ.tokenEnvKey, value: token.trim() }),
      });
      const envData = await envRes.json();
      if (!envData.success) {
        setMsg({ type: 'error', text: envData.error || 'Failed to save token' });
        setSaving(false);
        return;
      }

      // Enable the MCP server if it's disabled
      if (integ.mcpServerName) {
        try {
          // Check current MCP servers
          const mcpRes = await apiFetch('/api/mcp-servers');
          const mcpData = await mcpRes.json();
          const servers = mcpData.servers || [];
          const server = servers.find((s: { name: string }) => s.name === integ.mcpServerName);

          if (server && !server.enabled) {
            // Enable it
            await apiFetch(`/api/mcp-servers/${encodeURIComponent(integ.mcpServerName!)}/toggle`, { method: 'POST' });
          } else if (!server) {
            // Server doesn't exist yet — add it from disabled list
            await apiFetch(`/api/mcp-servers/${encodeURIComponent(integ.mcpServerName!)}/toggle`, { method: 'POST' });
          }
        } catch { /* MCP enable is best-effort */ }
      }

      setConnected(true);
      setToken('');
      setMsg({ type: 'success', text: `${integ.name} connected! MCP server enabled.` });
    } catch {
      setMsg({ type: 'error', text: 'Connection error' });
    }
    setSaving(false);
    setTimeout(() => setMsg(null), 4000);
  }

  async function handleDisconnect() {
    try {
      // Remove env var
      await apiFetch('/api/codeck/env', {
        method: 'DELETE',
        body: JSON.stringify({ key: integ.tokenEnvKey }),
      });

      // Disable MCP server
      if (integ.mcpServerName) {
        try {
          const mcpRes = await apiFetch('/api/mcp-servers');
          const mcpData = await mcpRes.json();
          const server = (mcpData.servers || []).find((s: { name: string; enabled: boolean }) => s.name === integ.mcpServerName && s.enabled);
          if (server) {
            await apiFetch(`/api/mcp-servers/${encodeURIComponent(integ.mcpServerName!)}/toggle`, { method: 'POST' });
          }
        } catch { /* best-effort */ }
      }

      setConnected(false);
      setMsg({ type: 'success', text: `${integ.name} disconnected` });
    } catch {
      setMsg({ type: 'error', text: 'Failed to disconnect' });
    }
    setTimeout(() => setMsg(null), 3000);
  }

  return (
    <div class="integ-detail">
      <div class="integ-detail-topbar">
        <button class="btn btn-xs btn-ghost" onClick={onBack}>
          <IconChevronLeft size={12} /> Integrations
        </button>
        {connected && (
          <button class="btn btn-xs btn-ghost danger" onClick={handleDisconnect}>
            <IconX size={11} /> Disconnect
          </button>
        )}
      </div>

      <div class="integ-detail-header">
        <div class="integ-detail-icon">{integ.icon()}</div>
        <div style="flex: 1">
          <h3 class="integ-detail-name">{integ.name}</h3>
          <p class="integ-detail-desc">{integ.description}</p>
        </div>
        <span class={`badge ${connected ? 'badge-success' : 'badge-muted'}`}>
          {checking ? 'Checking...' : connected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      {msg && <div class={`fb-toast fb-toast-${msg.type}`}>{msg.text}</div>}

      <div class="integ-section">
        <div class="integ-section-header">
          <IconKey size={14} />
          <span>API Token</span>
        </div>

        <div class="integ-section-body">
          {connected ? (
            <div class="integ-connected-info">
              <p class="integ-section-info">
                {integ.name} is connected. The MCP server is active and ready to use.
              </p>
            </div>
          ) : (
            <>
              <p class="integ-section-info">{integ.tokenHint}</p>
              {integ.tokenUrl && (
                <p class="integ-section-info">
                  <a href={integ.tokenUrl} target="_blank" rel="noopener noreferrer" style="color: var(--accent)">
                    Open {integ.name} Dashboard →
                  </a>
                </p>
              )}
              <div style="display: flex; gap: 8px; margin-top: 8px">
                <input
                  class="input"
                  type="password"
                  placeholder={`Paste your ${integ.name} token`}
                  value={token}
                  onInput={e => setToken((e.target as HTMLInputElement).value)}
                  onKeyDown={e => e.key === 'Enter' && handleConnect()}
                  style="flex: 1"
                />
                <button class="btn btn-sm btn-primary" onClick={handleConnect} disabled={saving || !token.trim()}>
                  {saving ? <span class="spinner-sm" /> : 'Connect'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── GitHub Detail ──

function GitHubDetail({ onBack }: { onBack: () => void }) {
  const [ssh, setSSH] = useState<SSHStatus>({ hasKey: false, publicKey: null, authenticated: false });
  const [github, setGitHub] = useState<GitHubStatus>({
    authenticated: false, loginInProgress: false,
    code: null, url: null, username: null, email: null, avatarUrl: null,
  });
  const [generating, setGenerating] = useState(false);
  const [testing, setTesting] = useState(false);
  const [ghConnecting, setGhConnecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadSSH();
    loadGitHub();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function loadSSH() {
    try {
      const res = await apiFetch('/api/ssh/status');
      const data = await res.json();
      setSSH({
        hasKey: data.hasKey || false,
        publicKey: data.publicKey || null,
        authenticated: data.authenticated || false,
      });
    } catch { /* ignore */ }
  }

  async function loadGitHub() {
    try {
      const res = await apiFetch('/api/github/login-status');
      const data = await res.json();
      setGitHub(data);
    } catch { /* ignore */ }
  }

  async function handleGenerate(force = false) {
    setGenerating(true);
    setMsg('');
    try {
      const res = await apiFetch('/api/ssh/generate', {
        method: 'POST',
        body: JSON.stringify({ force }),
      });
      const data = await res.json();
      if (data.success) {
        setMsg('SSH key generated');
        loadSSH();
      } else {
        setMsg(data.error || 'Generation failed');
      }
    } catch {
      setMsg('Error generating key');
    }
    setGenerating(false);
  }

  async function handleTest() {
    setTesting(true);
    try {
      const res = await apiFetch('/api/ssh/test');
      const data = await res.json();
      if (data.authenticated) {
        setSSH(prev => ({ ...prev, authenticated: true }));
        setMsg('SSH connection successful');
      } else {
        setMsg('SSH test failed — add key to GitHub first');
      }
    } catch {
      setMsg('Test failed');
    }
    setTesting(false);
  }

  async function handleCopy() {
    if (!ssh.publicKey) return;
    try {
      await navigator.clipboard.writeText(ssh.publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }

  async function handleGitHubLogin() {
    setGhConnecting(true);
    try {
      const res = await apiFetch('/api/github/login', { method: 'POST' });
      const data = await res.json();
      if (data.code) {
        setGitHub(prev => ({
          ...prev,
          loginInProgress: true,
          code: data.code,
          url: data.url,
        }));
        // Poll for completion
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
          try {
            const r = await apiFetch('/api/github/login-status');
            const d = await r.json();
            if (d.authenticated) {
              if (pollRef.current) clearInterval(pollRef.current);
              setGitHub(d);
              setGhConnecting(false);
            }
          } catch { /* retry */ }
        }, 2000);
      }
    } catch {
      setGhConnecting(false);
    }
  }

  return (
    <div class="integ-detail">
      <button class="integ-back" onClick={onBack}>
        <IconChevronLeft size={14} /> Back to Integrations
      </button>

      <div class="integ-detail-header">
        <div class="integ-detail-icon"><IconGithub size={28} /></div>
        <div>
          <h3 class="integ-detail-name">GitHub</h3>
          <p class="integ-detail-desc">SSH keys and account authentication for repositories</p>
        </div>
        {github.authenticated && <span class="badge badge-success">Connected</span>}
      </div>

      {msg && <div class={`fb-toast fb-toast-${msg.includes('fail') || msg.includes('Error') ? 'error' : 'success'}`}>{msg}</div>}

      {/* SSH Section */}
      <div class="integ-section">
        <div class="integ-section-header">
          <IconKey size={14} />
          <span>SSH Key</span>
          <span class={`badge ${ssh.hasKey ? (ssh.authenticated ? 'badge-success' : 'badge-info') : 'badge-muted'}`}>
            {ssh.hasKey ? (ssh.authenticated ? 'Verified' : 'Key exists') : 'No key'}
          </span>
        </div>

        <div class="integ-section-body">
          {ssh.hasKey ? (
            <>
              <div class="integ-pubkey-box">
                <code class="integ-pubkey">{ssh.publicKey || '...'}</code>
                <button class="btn btn-xs btn-ghost" onClick={handleCopy} title="Copy">
                  {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                </button>
              </div>
              <p class="integ-section-hint">
                Add this key at{' '}
                <a href="https://github.com/settings/keys" target="_blank" rel="noopener noreferrer">
                  github.com/settings/keys
                </a>
              </p>
              <div class="integ-actions">
                <button class="btn btn-xs btn-secondary" onClick={handleTest} disabled={testing}>
                  {testing ? <span class="spinner-sm" /> : <IconRefresh size={11} />}
                  Test Connection
                </button>
                <button class="btn btn-xs btn-ghost" onClick={() => handleGenerate(true)} disabled={generating}>
                  Regenerate
                </button>
              </div>
            </>
          ) : (
            <>
              <p class="integ-section-info">Generate an SSH key to clone repos via SSH.</p>
              <button class="btn btn-sm btn-primary" onClick={() => handleGenerate(false)} disabled={generating}>
                {generating ? <span class="spinner-sm" /> : <IconKey size={13} />}
                Generate SSH Key
              </button>
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
  const [connectedServices, setConnectedServices] = useState<Set<string>>(new Set());

  // Check which services are connected
  useEffect(() => {
    async function checkConnections() {
      const connected = new Set<string>();

      // GitHub via gh CLI
      try {
        const ghRes = await apiFetch('/api/github/login-status');
        const ghData = await ghRes.json();
        if (ghData.authenticated) connected.add('github');
      } catch { /* ignore */ }

      // Token-based services via env vars
      try {
        const envRes = await apiFetch('/api/codeck/env');
        const envData = await envRes.json();
        const vars = new Set((envData.vars || []).filter((v: { hasValue: boolean }) => v.hasValue).map((v: { key: string }) => v.key));

        for (const integ of INTEGRATIONS) {
          if (integ.tokenEnvKey && vars.has(integ.tokenEnvKey)) {
            connected.add(integ.id);
          }
        }
      } catch { /* ignore */ }

      setConnectedServices(connected);
    }

    checkConnections();
  }, [selected]); // re-check when returning from detail view

  // Render detail view
  const selectedInteg = INTEGRATIONS.find(i => i.id === selected);
  if (selectedInteg) {
    if (selectedInteg.id === 'github') {
      return (
        <div class="content-section">
          <div class="integ-content">
            <GitHubDetail onBack={() => setSelected(null)} />
          </div>
        </div>
      );
    }
    if (selectedInteg.tokenBased) {
      return (
        <div class="content-section">
          <div class="integ-content">
            <TokenIntegrationDetail integ={selectedInteg} onBack={() => setSelected(null)} />
          </div>
        </div>
      );
    }
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
              {connectedServices.has(integ.id) && <span class="badge badge-success">Connected</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
