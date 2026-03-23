import { useEffect, useRef, useState } from 'preact/hooks';
import { apiFetch } from '../../api';
import { showToast } from '../../state/store';
import { IconPlus, IconX } from '../Icons';
import { ConfirmModal } from '../ConfirmModal';

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
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { loadInstalled(); }, []);

  function loadInstalled() {
    apiFetch('/api/skills/installed')
      .then(r => r.json())
      .then(data => setInstalled(data.installed || []))
      .catch(() => {});
  }

  function searchSkills(q: string) {
    const searchTerm = q.trim() || 'claude';
    setLoading(true);
    apiFetch(`/api/skills/catalog?q=${encodeURIComponent(searchTerm)}`)
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

  // Load popular skills on mount
  useEffect(() => { searchSkills(''); }, []);

  async function handleInstall(skill: SkillEntry) {
    setInstalling(skill.skillId);
    try {
      const res = await apiFetch('/api/skills/install', {
        method: 'POST',
        body: JSON.stringify({ source: skill.source, skillId: skill.skillId }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Installed ${skill.name}`, 'success');
        loadInstalled();
      } else {
        showToast(data.error || 'Installation failed', 'error');
      }
    } catch {
      showToast('Connection error', 'error');
    }
    setInstalling(null);
  }

  async function handleUninstall(name: string) {
    setUninstalling(name);
    try {
      const res = await apiFetch('/api/skills/uninstall', {
        method: 'DELETE',
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Removed ${name}`, 'success');
        loadInstalled();
      } else {
        showToast(data.error || 'Remove failed', 'error');
      }
    } catch {
      showToast('Connection error', 'error');
    }
    setUninstalling(null);
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
        <div class="ac-list">
          {loading && results.length === 0 && (
            <div class="ac-empty"><span class="spinner-sm" /> Loading skills...</div>
          )}
          {!loading && results.length === 0 && query && (
            <div class="ac-empty">No skills found for "{query}"</div>
          )}
          {!loading && results.length === 0 && !query && (
            <div class="ac-empty">No skills available</div>
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
        <div class="ac-section" style="border-top: 1px solid var(--border); padding-top: 16px; margin-top: 8px">
          <div class="ac-section-title">Installed ({installed.length})</div>
          <div class="ac-list">
            {installed.map(name => (
              <div key={name} class="ac-list-item">
                <span class="ac-list-item-name">{name}</span>
                <button
                  class="btn btn-xs btn-ghost"
                  onClick={() => setUninstallTarget(name)}
                  disabled={uninstalling !== null}
                  title="Remove skill"
                >
                  {uninstalling === name ? <span class="spinner-sm" /> : <IconX size={12} />}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmModal
        visible={uninstallTarget !== null}
        title="Remove Skill"
        message={`Remove "${uninstallTarget}" from your installed skills? You can reinstall it later from the catalog.`}
        confirmLabel="Remove"
        onConfirm={() => { if (uninstallTarget) handleUninstall(uninstallTarget); setUninstallTarget(null); }}
        onCancel={() => setUninstallTarget(null)}
      />
    </div>
  );
}
