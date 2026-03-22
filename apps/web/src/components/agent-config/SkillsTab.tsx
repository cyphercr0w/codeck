import { useEffect, useRef, useState } from 'preact/hooks';
import { apiFetch } from '../../api';
import { IconPlus } from '../Icons';

interface SkillEntry {
  source: string;
  skillId: string;
  name: string;
  installs: number;
}

function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function SkillsTab() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SkillEntry[]>([]);
  const [installed, setInstalled] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { loadInstalled(); }, []);

  function loadInstalled() {
    apiFetch('/api/skills/installed')
      .then(r => r.json())
      .then(data => setInstalled(data.installed || []))
      .catch(() => {});
  }

  function searchSkills(q: string) {
    if (!q.trim()) { setResults([]); setLoading(false); return; }
    setLoading(true);
    apiFetch(`/api/skills/catalog?q=${encodeURIComponent(q)}`)
      .then(r => r.json())
      .then(data => setResults(data.skills || []))
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }

  function handleInput(q: string) {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => searchSkills(q), 300);
  }

  async function handleInstall(skill: SkillEntry) {
    setInstalling(skill.skillId);
    setMsg(null);
    try {
      const res = await apiFetch('/api/skills/install', {
        method: 'POST',
        body: JSON.stringify({ source: skill.source, skillId: skill.skillId }),
      });
      const data = await res.json();
      if (data.success) {
        setMsg({ type: 'success', text: `Installed ${skill.name}` });
        loadInstalled();
      } else {
        setMsg({ type: 'error', text: data.error || 'Installation failed' });
      }
    } catch {
      setMsg({ type: 'error', text: 'Connection error' });
    }
    setInstalling(null);
    setTimeout(() => setMsg(null), 4000);
  }

  const installedSet = new Set(installed);

  return (
    <div class="ac-tab-content">
      <div class="ac-section">
        <div class="ac-section-title">Browse Skills</div>
        <input
          class="ac-search"
          placeholder="Search 89K+ skills from skills.sh..."
          value={query}
          onInput={e => handleInput((e.target as HTMLInputElement).value)}
        />
        {msg && <div class={`fb-toast fb-toast-${msg.type}`}>{msg.text}</div>}
        <div class="ac-list">
          {loading && results.length === 0 && (
            <div class="ac-empty"><span class="spinner-sm" /> Loading skills...</div>
          )}
          {!loading && results.length === 0 && query && (
            <div class="ac-empty">No skills found for "{query}"</div>
          )}
          {!loading && results.length === 0 && !query && (
            <div class="ac-empty">Type to search the skills catalog</div>
          )}
          {results.map(skill => (
            <div key={`${skill.source}/${skill.skillId}`} class="ac-list-item">
              <div class="ac-list-item-info">
                <span class="ac-list-item-name">{skill.name}</span>
                <span class="ac-list-item-meta">{skill.source} &middot; {formatInstalls(skill.installs)} installs</span>
              </div>
              {installedSet.has(skill.name) ? (
                <span class="badge badge-success">Installed</span>
              ) : (
                <button
                  class="btn btn-xs btn-primary"
                  onClick={() => handleInstall(skill)}
                  disabled={installing !== null}
                >
                  {installing === skill.skillId ? <span class="spinner-sm" /> : <><IconPlus size={11} /> Install</>}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {installed.length > 0 && (
        <div class="ac-section">
          <div class="ac-section-title">Installed ({installed.length})</div>
          <div class="ac-list">
            {installed.map(name => (
              <div key={name} class="ac-list-item">
                <span class="ac-list-item-name">{name}</span>
                <span class="badge badge-success">Installed</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
