import { useEffect, useState } from 'preact/hooks';
import { apiFetch } from '../../api';
import { showToast } from '../../state/store';
import { IconShield, IconPlug, IconLock } from '../Icons';

interface McpServer {
  name: string;
  allowed: boolean;
  disabled: boolean;
}

interface DenyRule {
  pattern: string;
}

interface AllPermissions {
  basic: Record<string, boolean>;
  mcp: McpServer[];
  deny: DenyRule[];
}

const PERMISSION_LABELS: Record<string, string> = {
  Read: 'Read files',
  Edit: 'Edit files',
  Write: 'Write files',
  Bash: 'Run commands',
  WebFetch: 'Fetch URLs',
  WebSearch: 'Web search',
};

const MCP_LABELS: Record<string, string> = {
  context7: 'Context7 — Library docs',
  'sequential-thinking': 'Sequential Thinking',
  eslint: 'ESLint — Lint files',
  playwright: 'Playwright — Browser testing',
  'brave-search': 'Brave Search',
  github: 'GitHub',
  memory: 'Memory — Knowledge graph',
  magic: 'Magic UI — Design registry',
  'token-optimizer': 'Token Optimizer',
};

export function PermissionsTab() {
  const [data, setData] = useState<AllPermissions | null>(null);

  useEffect(() => {
    apiFetch('/api/permissions/all')
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => {});
  }, []);

  async function toggleBasic(name: string) {
    if (!data) return;
    const prev = { ...data.basic };
    setData(d => d ? { ...d, basic: { ...d.basic, [name]: !d.basic[name] } } : d);
    try {
      await apiFetch('/api/permissions', {
        method: 'POST',
        body: JSON.stringify({ [name]: !prev[name] }),
      });
    } catch {
      setData(d => d ? { ...d, basic: prev } : d);
    }
  }

  async function toggleAllBasic() {
    if (!data) return;
    const prev = { ...data.basic };
    const allOn = Object.values(data.basic).every(v => v);
    const target = !allOn;
    const updated: Record<string, boolean> = {};
    for (const key of Object.keys(data.basic)) updated[key] = target;
    setData(d => d ? { ...d, basic: updated } : d);
    try {
      await apiFetch('/api/permissions', {
        method: 'POST',
        body: JSON.stringify(updated),
      });
    } catch {
      setData(d => d ? { ...d, basic: prev } : d);
    }
  }

  async function toggleMcp(serverName: string, currentAllowed: boolean) {
    if (!data) return;
    const prev = [...data.mcp];
    setData(d => d ? {
      ...d,
      mcp: d.mcp.map(s => s.name === serverName ? { ...s, allowed: !currentAllowed } : s),
    } : d);
    try {
      const res = await apiFetch('/api/permissions/mcp', {
        method: 'POST',
        body: JSON.stringify({ name: serverName, allowed: !currentAllowed }),
      });
      const result = await res.json();
      if (result.servers) {
        setData(d => d ? { ...d, mcp: result.servers } : d);
      }
      showToast(`${serverName} ${!currentAllowed ? 'allowed' : 'blocked'}`, 'success');
    } catch {
      setData(d => d ? { ...d, mcp: prev } : d);
      showToast('Failed to update MCP permission', 'error');
    }
  }

  if (!data) return <div class="ac-tab-content"><div class="ac-empty"><span class="spinner-sm" /> Loading...</div></div>;

  const allBasicOn = Object.values(data.basic).every(v => v);
  const enabledBasic = Object.values(data.basic).filter(v => v).length;
  const totalBasic = Object.keys(data.basic).length;
  const enabledMcp = data.mcp.filter(s => s.allowed && !s.disabled).length;
  const totalMcp = data.mcp.length;

  return (
    <div class="ac-tab-content">
      {/* Basic Tool Permissions */}
      <div class="ac-section">
        <div class="ac-section-header">
          <div class="ac-section-title"><IconShield size={14} /> Tool Permissions</div>
          <label class="ac-toggle" title={allBasicOn ? 'Disable all' : 'Enable all'}>
            <input type="checkbox" checked={allBasicOn} onChange={toggleAllBasic} />
            <span class="ac-toggle-slider" />
          </label>
        </div>
        <div class="ac-list">
          {Object.keys(data.basic).map(p => (
            <div key={p} class="ac-list-item">
              <span class="ac-list-item-name">{PERMISSION_LABELS[p] || p}</span>
              <label class="ac-toggle">
                <input type="checkbox" checked={data.basic[p]} onChange={() => toggleBasic(p)} />
                <span class="ac-toggle-slider" />
              </label>
            </div>
          ))}
        </div>
        <div class="ac-hint">
          {allBasicOn ? 'All tools granted — agent works without asking.' : `${enabledBasic}/${totalBasic} enabled — agent asks before using disabled tools.`}
        </div>
      </div>

      {/* MCP Server Permissions */}
      {data.mcp.length > 0 && (
        <div class="ac-section">
          <div class="ac-section-header">
            <div class="ac-section-title"><IconPlug size={14} /> MCP Server Permissions</div>
            <span class="ac-section-count">{enabledMcp}/{totalMcp}</span>
          </div>
          <div class="ac-list">
            {data.mcp.map(s => (
              <div key={s.name} class={`ac-list-item${s.disabled ? ' ac-list-item-disabled' : ''}`}>
                <div>
                  <span class="ac-list-item-name">{MCP_LABELS[s.name] || s.name}</span>
                  {s.disabled && <span class="ac-list-item-badge">Server disabled</span>}
                </div>
                <label class="ac-toggle">
                  <input
                    type="checkbox"
                    checked={s.allowed && !s.disabled}
                    disabled={s.disabled}
                    onChange={() => toggleMcp(s.name, s.allowed)}
                  />
                  <span class="ac-toggle-slider" />
                </label>
              </div>
            ))}
          </div>
          <div class="ac-hint">
            Allowed MCP servers can be used by the agent without permission prompts.
            Disabled servers must be enabled in the MCP Servers tab first.
          </div>
        </div>
      )}

      {/* Deny Rules */}
      {data.deny.length > 0 && (
        <div class="ac-section">
          <div class="ac-section-header">
            <div class="ac-section-title"><IconLock size={14} /> Deny Rules</div>
          </div>
          <div class="ac-list">
            {data.deny.map((r, i) => (
              <div key={i} class="ac-list-item">
                <code class="ac-deny-pattern">{r.pattern}</code>
              </div>
            ))}
          </div>
          <div class="ac-hint">
            These patterns are always blocked, even if the base permission is allowed.
          </div>
        </div>
      )}
    </div>
  );
}
