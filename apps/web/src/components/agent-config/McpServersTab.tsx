import { useEffect, useRef, useState } from 'preact/hooks';
import { apiFetch } from '../../api';
import { IconPlus, IconX, IconDownload } from '../Icons';
import { ConfirmModal } from '../ConfirmModal';

// Installed server (from .claude.json)
interface McpServer {
  name: string;
  command: string;
  args: string[];
  envKeys?: string[];
  description?: string;
  enabled: boolean;
}

// Registry search result
interface RegistryServer {
  registryName: string;
  title: string;
  description: string;
  command: string;
  args: string[];
  envVars: { name: string; description: string; required: boolean }[];
  runtime: string;
}

export function McpServersTab() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  // Search state
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RegistryServer[]>([]);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Env var form for servers that need API keys (from registry search)
  const [envForm, setEnvForm] = useState<{ server: RegistryServer; values: Record<string, string> } | null>(null);

  // Enable modal for disabled servers that need API keys
  const [enableTarget, setEnableTarget] = useState<{ server: McpServer; values: Record<string, string> } | null>(null);
  const [enabling, setEnabling] = useState(false);

  useEffect(() => { loadServers(); }, []);

  async function loadServers() {
    try {
      const res = await apiFetch('/api/mcp-servers');
      const data = await res.json();
      setServers(data.servers || []);
    } catch {
      setMsg({ type: 'error', text: 'Failed to load MCP servers' });
    }
    setLoading(false);
  }

  function searchRegistry(q: string) {
    const searchTerm = q.trim() || 'popular';
    setSearching(true);
    apiFetch(`/api/mcp-servers/search?q=${encodeURIComponent(searchTerm)}`)
      .then(r => r.json())
      .then(data => setResults(data.servers || []))
      .catch(() => setResults([]))
      .finally(() => setSearching(false));
  }

  function handleInput(q: string) {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => searchRegistry(q), 350);
  }

  // Load featured servers on mount
  useEffect(() => { searchRegistry(''); }, []);

  async function handleInstall(server: RegistryServer) {
    // If server needs env vars, show the env form first
    const requiredVars = server.envVars.filter(v => v.required);
    if (requiredVars.length > 0 && !envForm) {
      const values: Record<string, string> = {};
      for (const v of requiredVars) values[v.name] = '';
      setEnvForm({ server, values });
      return;
    }

    setInstalling(server.registryName);
    setMsg(null);
    try {
      // Derive a short name from the registry name
      const shortName = server.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || server.registryName.split('/').pop() || 'mcp-server';

      // Build env from form if present
      const env: Record<string, string> = {};
      if (envForm?.server.registryName === server.registryName) {
        for (const [k, v] of Object.entries(envForm.values)) {
          if (v.trim()) env[k] = v.trim();
        }
      }

      const body: Record<string, unknown> = {
        name: shortName,
        command: server.command,
        args: server.args,
        description: server.description || server.title,
      };
      if (Object.keys(env).length > 0) body.env = env;

      const res = await apiFetch('/api/mcp-servers', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setMsg({ type: 'success', text: `Installed ${server.title}` });
        setEnvForm(null);
        await loadServers();
      } else {
        setMsg({ type: 'error', text: data.error || 'Install failed' });
      }
    } catch {
      setMsg({ type: 'error', text: 'Connection error' });
    }
    setInstalling(null);
    setTimeout(() => setMsg(null), 4000);
  }

  async function handleToggle(name: string) {
    const server = servers.find(s => s.name === name);
    // If enabling a disabled server that needs API keys, show the env form first
    if (server && !server.enabled && server.envKeys && server.envKeys.length > 0) {
      const values: Record<string, string> = {};
      for (const k of server.envKeys) values[k] = '';
      setEnableTarget({ server, values });
      return;
    }

    setToggling(name);
    try {
      const res = await apiFetch(`/api/mcp-servers/${encodeURIComponent(name)}/toggle`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        await loadServers();
      } else {
        setMsg({ type: 'error', text: data.error || 'Toggle failed' });
      }
    } catch {
      setMsg({ type: 'error', text: 'Connection error' });
    }
    setToggling(null);
  }

  async function handleEnableWithKeys() {
    if (!enableTarget) return;
    setEnabling(true);
    try {
      // First set env vars, then toggle
      for (const [key, value] of Object.entries(enableTarget.values)) {
        if (value.trim()) {
          await apiFetch('/api/codeck/env', {
            method: 'POST',
            body: JSON.stringify({ key, value: value.trim() }),
          });
        }
      }
      // Now enable the server and inject env vars into its config
      const res = await apiFetch(`/api/mcp-servers/${encodeURIComponent(enableTarget.server.name)}/toggle`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setMsg({ type: 'success', text: `Enabled ${enableTarget.server.name}` });
        await loadServers();
      } else {
        setMsg({ type: 'error', text: data.error || 'Enable failed' });
      }
    } catch {
      setMsg({ type: 'error', text: 'Connection error' });
    }
    setEnableTarget(null);
    setEnabling(false);
    setTimeout(() => setMsg(null), 3000);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      const res = await apiFetch(`/api/mcp-servers/${encodeURIComponent(deleteTarget)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setMsg({ type: 'success', text: `Removed ${deleteTarget}` });
        await loadServers();
      } else {
        setMsg({ type: 'error', text: data.error || 'Delete failed' });
      }
    } catch {
      setMsg({ type: 'error', text: 'Connection error' });
    }
    setDeleteTarget(null);
    setTimeout(() => setMsg(null), 3000);
  }

  const installedNames = new Set(servers.map(s => s.name));

  return (
    <div class="ac-tab-content">
      {msg && <div class={`fb-toast fb-toast-${msg.type}`}>{msg.text}</div>}

      {/* Browse / search registry */}
      <div class="ac-section">
        <div class="ac-section-title">Browse Registry</div>
        <input
          class="ac-search"
          placeholder="Search 12K+ MCP servers (e.g. gmail, supabase, stripe)..."
          value={query}
          onInput={e => handleInput((e.target as HTMLInputElement).value)}
        />

        {/* Env var form overlay */}
        {envForm && (
          <div class="ac-add-form">
            <div class="ac-section-title" style="margin-bottom: 4px">
              {envForm.server.title} requires configuration
            </div>
            {envForm.server.envVars.filter(v => v.required).map(v => (
              <div key={v.name}>
                <label class="ac-input-label">{v.name}{v.description && <span class="ac-list-item-meta"> — {v.description}</span>}</label>
                <input
                  class="ac-input"
                  placeholder={v.name}
                  value={envForm.values[v.name] || ''}
                  onInput={e => setEnvForm(prev => prev ? ({
                    ...prev,
                    values: { ...prev.values, [v.name]: (e.target as HTMLInputElement).value },
                  }) : null)}
                />
              </div>
            ))}
            <div class="ac-add-form-actions">
              <button class="btn btn-xs btn-ghost" onClick={() => setEnvForm(null)}>Cancel</button>
              <button
                class="btn btn-xs btn-primary"
                onClick={() => handleInstall(envForm.server)}
                disabled={installing !== null || envForm.server.envVars.filter(v => v.required).some(v => !envForm.values[v.name]?.trim())}
              >
                {installing ? <span class="spinner-sm" /> : <><IconDownload size={11} /> Install</>}
              </button>
            </div>
          </div>
        )}

        <div class="ac-list">
          {searching && results.length === 0 && (
            <div class="ac-empty"><span class="spinner-sm" /> Searching registry...</div>
          )}
          {!searching && results.length === 0 && query && (
            <div class="ac-empty">No servers found for "{query}"</div>
          )}
          {!searching && results.length === 0 && !query && (
            <div class="ac-empty">No servers available</div>
          )}
          {results.map(s => {
            const alreadyInstalled = installedNames.has(
              s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
            );
            return (
              <div key={s.registryName} class="ac-list-item">
                <div class="ac-list-item-info">
                  <span class="ac-list-item-name">{s.title}</span>
                  <span class="ac-list-item-meta">
                    {s.description}
                    {s.envVars.length > 0 && <> &middot; requires: {s.envVars.filter(v => v.required).map(v => v.name).join(', ')}</>}
                  </span>
                </div>
                {alreadyInstalled ? (
                  <span class="badge badge-success">Installed</span>
                ) : (
                  <button
                    class="btn btn-xs btn-primary"
                    onClick={() => handleInstall(s)}
                    disabled={installing !== null}
                  >
                    {installing === s.registryName ? <span class="spinner-sm" /> : <><IconDownload size={11} /> Install</>}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Installed servers */}
      {!loading && servers.length > 0 && (
        <div class="ac-section" style="border-top: 1px solid var(--border); padding-top: 16px; margin-top: 8px">
          <div class="ac-section-title">Installed ({servers.length})</div>
          <div class="ac-list">
            {servers.map(s => (
              <div key={s.name} class={`ac-list-item${!s.enabled ? ' ac-disabled' : ''}`}>
                <div class="ac-list-item-info">
                  <span class="ac-list-item-name">{s.name}</span>
                  <span class="ac-list-item-meta">
                    {s.command} {s.args.join(' ')}
                    {s.description && <> &middot; {s.description}</>}
                  </span>
                </div>
                <div class="ac-list-item-actions">
                  <label class="ac-toggle" title={s.enabled ? 'Disable' : 'Enable'}>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={() => handleToggle(s.name)}
                      disabled={toggling === s.name}
                    />
                    <span class="ac-toggle-slider" />
                  </label>
                  <button class="btn btn-xs btn-ghost" onClick={() => setDeleteTarget(s.name)} title="Remove">
                    <IconX size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmModal
        visible={deleteTarget !== null}
        title="Remove MCP Server"
        message={`Remove "${deleteTarget}" from your MCP servers? This cannot be undone.`}
        confirmLabel="Remove"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Enable modal — asks for API keys before enabling a disabled server */}
      {enableTarget && (
        <div class="ac-viewer-overlay" onClick={() => setEnableTarget(null)}>
          <div class="ac-viewer" onClick={e => e.stopPropagation()} style="max-width: 450px">
            <div class="ac-viewer-header">
              <span>Enable {enableTarget.server.name}</span>
              <button class="btn btn-xs btn-ghost" onClick={() => setEnableTarget(null)}>
                <IconX size={12} />
              </button>
            </div>
            <div style="padding: 16px; display: flex; flex-direction: column; gap: 12px">
              <div class="ac-hint">This server requires API keys to work. Fill them in below.</div>
              {Object.keys(enableTarget.values).map(key => (
                <div key={key}>
                  <label class="ac-list-item-meta" style="display: block; margin-bottom: 4px">{key}</label>
                  <input
                    class="ac-input"
                    type="password"
                    placeholder={key}
                    value={enableTarget.values[key]}
                    onInput={e => setEnableTarget(prev => prev ? ({
                      ...prev,
                      values: { ...prev.values, [key]: (e.target as HTMLInputElement).value },
                    }) : null)}
                  />
                </div>
              ))}
              <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px">
                <button class="btn btn-xs btn-ghost" onClick={() => setEnableTarget(null)}>Cancel</button>
                <button
                  class="btn btn-xs btn-primary"
                  onClick={handleEnableWithKeys}
                  disabled={enabling || Object.values(enableTarget.values).some(v => !v.trim())}
                >
                  {enabling ? <span class="spinner-sm" /> : 'Enable'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
