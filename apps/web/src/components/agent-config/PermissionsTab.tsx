import { useEffect, useState } from 'preact/hooks';
import { apiFetch } from '../../api';
import { IconShield } from '../Icons';

const PERMISSION_LABELS: Record<string, string> = {
  Read: 'Read files',
  Edit: 'Edit files',
  Write: 'Write files',
  Bash: 'Run commands',
  WebFetch: 'Fetch URLs',
  WebSearch: 'Web search',
};

export function PermissionsTab() {
  const [perms, setPerms] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    apiFetch('/api/permissions')
      .then(r => r.json())
      .then(data => setPerms(data))
      .catch(() => {});
  }, []);

  async function togglePerm(name: string) {
    if (!perms) return;
    const prev = { ...perms };
    setPerms(p => p ? { ...p, [name]: !p[name] } : p);
    try {
      await apiFetch('/api/permissions', {
        method: 'POST',
        body: JSON.stringify({ [name]: !prev[name] }),
      });
    } catch {
      setPerms(prev);
    }
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
      await apiFetch('/api/permissions', {
        method: 'POST',
        body: JSON.stringify(updated),
      });
    } catch {
      setPerms(prev);
    }
  }

  if (!perms) return <div class="ac-tab-content"><div class="ac-empty"><span class="spinner-sm" /> Loading...</div></div>;

  const allOn = Object.values(perms).every(v => v);
  const enabledCount = Object.values(perms).filter(v => v).length;
  const totalCount = Object.keys(perms).length;

  return (
    <div class="ac-tab-content">
      <div class="ac-section">
        <div class="ac-section-header">
          <div class="ac-section-title"><IconShield size={14} /> Agent Permissions</div>
          <label class="ac-toggle" title={allOn ? 'Disable all' : 'Enable all'}>
            <input type="checkbox" checked={allOn} onChange={toggleAll} />
            <span class="ac-toggle-slider" />
          </label>
        </div>
        <div class="ac-list">
          {Object.keys(perms).map(p => (
            <div key={p} class="ac-list-item">
              <span class="ac-list-item-name">{PERMISSION_LABELS[p] || p}</span>
              <label class="ac-toggle">
                <input type="checkbox" checked={perms[p]} onChange={() => togglePerm(p)} />
                <span class="ac-toggle-slider" />
              </label>
            </div>
          ))}
        </div>
        <div class="ac-hint">
          {allOn ? 'All permissions granted — agent can use all tools without asking.' : `${enabledCount}/${totalCount} enabled — agent will ask before using disabled tools.`}
        </div>
      </div>
    </div>
  );
}
