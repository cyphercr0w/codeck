import { useEffect, useRef, useState } from 'preact/hooks';
import { apiFetch } from '../../api';
import { IconPlus, IconFolder, IconX } from '../Icons';

interface RuleFile {
  name: string;
  path: string;
  source: 'base' | 'user';
}

export function RulesTab() {
  const [rules, setRules] = useState<RuleFile[]>([]);
  const [preferences, setPreferences] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Add rule form
  const [addOpen, setAddOpen] = useState(false);
  const [newRuleText, setNewRuleText] = useState('');
  const [saving, setSaving] = useState(false);

  // Preference input
  const [prefInput, setPrefInput] = useState('');
  const [savingPref, setSavingPref] = useState(false);

  // View rule
  const [viewing, setViewing] = useState<{ name: string; content: string } | null>(null);

  useEffect(() => { loadRules(); loadPreferences(); }, []);

  async function loadRules() {
    setLoading(true);
    try {
      const [baseRes, userRes] = await Promise.all([
        apiFetch('/api/codeck/files?path=rules/base').then(r => r.json()).catch(() => ({ items: [] })),
        apiFetch('/api/codeck/files?path=rules/user').then(r => r.json()).catch(() => ({ items: [] })),
      ]);
      const baseFiles: RuleFile[] = (baseRes.items || [])
        .filter((f: any) => !f.isDirectory && f.name.endsWith('.md'))
        .map((f: any) => ({ name: f.name, path: `rules/base/${f.name}`, source: 'base' as const }));
      const userFiles: RuleFile[] = (userRes.items || [])
        .filter((f: any) => !f.isDirectory && f.name.endsWith('.md'))
        .map((f: any) => ({ name: f.name, path: `rules/user/${f.name}`, source: 'user' as const }));
      setRules([...userFiles, ...baseFiles]);
    } catch {
      setMsg({ type: 'error', text: 'Failed to load rules' });
    }
    setLoading(false);
  }

  async function loadPreferences() {
    try {
      const res = await apiFetch('/api/codeck/files/read?path=preferences.md');
      const data = await res.json();
      if (data.success) setPreferences(data.content || '');
    } catch { /* non-fatal */ }
  }

  async function handleAddRule() {
    const trimmed = newRuleText.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const filename = trimmed.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.md';
      const content = `# ${trimmed.split('\n')[0]}\n\n${trimmed}\n`;
      const res = await apiFetch('/api/codeck/files/write', {
        method: 'PUT',
        body: JSON.stringify({ path: `rules/user/${filename}`, content }),
      });
      const data = await res.json();
      if (data.success) {
        setMsg({ type: 'success', text: `Rule saved as ${filename}` });
        setNewRuleText('');
        setAddOpen(false);
        await loadRules();
      } else {
        setMsg({ type: 'error', text: data.error || 'Save failed' });
      }
    } catch {
      setMsg({ type: 'error', text: 'Connection error' });
    }
    setSaving(false);
    setTimeout(() => setMsg(null), 3000);
  }

  async function handleAddPreference() {
    const trimmed = prefInput.trim();
    if (!trimmed) return;
    setSavingPref(true);
    try {
      const newContent = preferences.trimEnd() + '\n- ' + trimmed + '\n';
      const res = await apiFetch('/api/codeck/files/write', {
        method: 'PUT',
        body: JSON.stringify({ path: 'preferences.md', content: newContent }),
      });
      const data = await res.json();
      if (data.success) {
        setMsg({ type: 'success', text: 'Preference saved' });
        setPrefInput('');
        setPreferences(newContent);
      } else {
        setMsg({ type: 'error', text: data.error || 'Save failed' });
      }
    } catch {
      setMsg({ type: 'error', text: 'Connection error' });
    }
    setSavingPref(false);
    setTimeout(() => setMsg(null), 3000);
  }

  async function viewRule(rule: RuleFile) {
    try {
      const res = await apiFetch(`/api/codeck/files/read?path=${encodeURIComponent(rule.path)}`);
      const data = await res.json();
      if (data.success) {
        setViewing({ name: rule.name, content: data.content });
      }
    } catch { /* ignore */ }
  }

  return (
    <div class="ac-tab-content">
      {msg && <div class={`fb-toast fb-toast-${msg.type}`}>{msg.text}</div>}

      {/* Preferences */}
      <div class="ac-section">
        <div class="ac-section-title">Preferences</div>
        <div class="ac-pref-input">
          <input
            class="ac-search"
            placeholder="Add a preference (e.g. Always use TypeScript strict mode)"
            value={prefInput}
            onInput={e => setPrefInput((e.target as HTMLInputElement).value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAddPreference(); }}
          />
          <button class="btn btn-xs btn-primary" onClick={handleAddPreference} disabled={savingPref || !prefInput.trim()}>
            {savingPref ? <span class="spinner-sm" /> : <IconPlus size={11} />}
          </button>
        </div>
        {preferences && (
          <pre class="ac-pref-preview">{preferences}</pre>
        )}
      </div>

      {/* Rules */}
      <div class="ac-section">
        <div class="ac-section-header">
          <div class="ac-section-title">Rules</div>
          <button class="btn btn-xs btn-primary" onClick={() => setAddOpen(o => !o)}>
            <IconPlus size={11} /> Add Rule
          </button>
        </div>

        {addOpen && (
          <div class="ac-add-form">
            <textarea
              class="ac-textarea"
              placeholder="Write a rule (e.g. Never commit directly to main without tests)"
              value={newRuleText}
              onInput={e => setNewRuleText((e.target as HTMLTextAreaElement).value)}
              rows={3}
            />
            <div class="ac-add-form-actions">
              <button class="btn btn-xs btn-ghost" onClick={() => setAddOpen(false)}>Cancel</button>
              <button class="btn btn-xs btn-primary" onClick={handleAddRule} disabled={saving || !newRuleText.trim()}>
                {saving ? <span class="spinner-sm" /> : 'Save Rule'}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div class="ac-empty"><span class="spinner-sm" /> Loading...</div>
        ) : rules.length === 0 ? (
          <div class="ac-empty">No rules configured</div>
        ) : (
          <div class="ac-list">
            {rules.map(rule => (
              <div key={rule.path} class="ac-list-item" onClick={() => viewRule(rule)} style="cursor: pointer">
                <div class="ac-list-item-info">
                  <span class="ac-list-item-name">{rule.name.replace('.md', '')}</span>
                  <span class="ac-list-item-meta">{rule.source === 'base' ? 'System rule' : 'User rule'}</span>
                </div>
                <span class={`badge ${rule.source === 'base' ? 'badge-info' : 'badge-success'}`}>
                  {rule.source}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Rule viewer */}
      {viewing && (
        <div class="ac-viewer-overlay" onClick={() => setViewing(null)}>
          <div class="ac-viewer" onClick={e => e.stopPropagation()}>
            <div class="ac-viewer-header">
              <span>{viewing.name}</span>
              <button class="btn btn-xs btn-ghost" onClick={() => setViewing(null)}>
                <IconX size={12} />
              </button>
            </div>
            <pre class="ac-viewer-content">{viewing.content}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
