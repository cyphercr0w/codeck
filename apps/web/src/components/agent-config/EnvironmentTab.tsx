import { useEffect, useState } from 'preact/hooks';
import { apiFetch } from '../../api';
import { IconKey, IconPlus, IconX } from '../Icons';

export function EnvironmentTab() {
  const [vars, setVars] = useState<Array<{ key: string; hasValue: boolean }>>([]);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => { loadVars(); }, []);

  async function loadVars() {
    try {
      const res = await apiFetch('/api/codeck/env');
      const data = await res.json();
      setVars(data.vars || []);
    } catch { /* ignore */ }
  }

  async function handleAdd() {
    const key = newKey.trim().toUpperCase();
    if (!key || !newValue) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch('/api/codeck/env', {
        method: 'POST',
        body: JSON.stringify({ key, value: newValue }),
      });
      const data = await res.json();
      if (data.success) {
        setMsg({ type: 'success', text: `${key} saved` });
        setNewKey('');
        setNewValue('');
        loadVars();
      } else {
        setMsg({ type: 'error', text: data.error || 'Failed' });
      }
    } catch {
      setMsg({ type: 'error', text: 'Connection error' });
    }
    setSaving(false);
    setTimeout(() => setMsg(null), 3000);
  }

  async function handleDelete(key: string) {
    try {
      await apiFetch('/api/codeck/env', {
        method: 'DELETE',
        body: JSON.stringify({ key }),
      });
      loadVars();
    } catch { /* ignore */ }
  }

  return (
    <div class="ac-tab-content">
      {msg && <div class={`fb-toast fb-toast-${msg.type}`}>{msg.text}</div>}

      <div class="ac-section">
        <div class="ac-section-title"><IconKey size={14} /> Environment Variables</div>
        <div class="ac-hint">
          Variables are injected into every new terminal session. Changes apply on next session start.
        </div>

        <div class="ac-add-form" style="flex-direction: row; align-items: center; gap: 8px; padding: 8px 12px">
          <input
            class="ac-input"
            style="flex: 1"
            placeholder="KEY_NAME"
            value={newKey}
            onInput={e => setNewKey((e.target as HTMLInputElement).value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
          <input
            class="ac-input"
            style="flex: 1"
            type="password"
            placeholder="value"
            value={newValue}
            onInput={e => setNewValue((e.target as HTMLInputElement).value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
          <button class="btn btn-xs btn-primary" onClick={handleAdd} disabled={saving || !newKey.trim() || !newValue}>
            {saving ? <span class="spinner-sm" /> : <IconPlus size={11} />}
          </button>
        </div>

        {vars.length > 0 && (
          <div class="ac-list">
            {vars.map(v => (
              <div key={v.key} class="ac-list-item">
                <div class="ac-list-item-info">
                  <code class="ac-list-item-name" style="font-family: var(--font-mono)">{v.key}</code>
                  <span class="ac-list-item-meta">{v.hasValue ? '••••••••' : '(empty)'}</span>
                </div>
                <button class="btn btn-xs btn-ghost" onClick={() => handleDelete(v.key)} title="Delete">
                  <IconX size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
