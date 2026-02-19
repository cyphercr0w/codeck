import { useState, useEffect, useRef } from 'preact/hooks';
import DOMPurify from 'dompurify';
import { apiFetch } from '../api';
import { IconEdit, IconSave, IconPlus, IconRefresh, IconCalendar, IconBookmark, IconFolder, IconSearch } from './Icons';

type MemoryTab = 'durable' | 'daily' | 'decisions' | 'paths' | 'search';

/** Sanitize FTS5 snippets using DOMPurify, only allowing <mark> highlight tags. */
function sanitizeSnippet(raw: string): string {
  return DOMPurify.sanitize(raw, { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: [] });
}

interface DailyEntry {
  date: string;
  size: number;
}

interface DecisionItem {
  filename: string;
  title: string;
  date: string;
}

interface PathScope {
  pathId: string;
  canonicalPath: string;
  name: string;
  createdAt: number;
}

// ── Durable View ──

function DurableView() {
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/memory/durable');
      const data = await res.json();
      setContent(data.content || '');
      setEditContent(data.content || '');
    } catch {
      setError('Failed to load durable memory.');
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function save() {
    setSaving(true);
    try {
      await apiFetch('/api/memory/durable', {
        method: 'PUT',
        body: JSON.stringify({ content: editContent }),
      });
      setContent(editContent);
      setEditing(false);
      setMsg('Saved');
      setTimeout(() => setMsg(''), 2000);
    } catch {
      setMsg('Save failed');
    }
    setSaving(false);
  }

  if (loading) return <div class="memory-loading"><span class="loading" /> Loading...</div>;

  return (
    <div class="memory-view">
      <div class="memory-view-header">
        <span class="memory-view-title">MEMORY.md</span>
        <div class="memory-view-actions">
          {msg && <span class={`config-save-msg ${msg === 'Saved' ? 'success' : 'error'}`}>{msg}</span>}
          {editing ? (
            <>
              <button class="btn btn-sm btn-secondary" onClick={() => { setEditing(false); setEditContent(content); }}>Cancel</button>
              <button class="btn btn-sm btn-primary" onClick={save} disabled={saving}>
                <IconSave size={12} /> {saving ? 'Saving...' : 'Save'}
              </button>
            </>
          ) : (
            <>
              <button class="btn btn-sm btn-secondary" onClick={() => setEditing(true)}>
                <IconEdit size={12} /> Edit
              </button>
              <button class="btn btn-sm btn-ghost" onClick={load}><IconRefresh size={12} /></button>
            </>
          )}
        </div>
      </div>
      {error && <div class="memory-error" role="alert">{error}</div>}
      {editing ? (
        <textarea
          class="memory-editor"
          value={editContent}
          onInput={(e) => setEditContent((e.target as HTMLTextAreaElement).value)}
          spellcheck={false}
        />
      ) : (
        <pre class="memory-content">{content || 'No durable memory yet. Click Edit to create one.'}</pre>
      )}
    </div>
  );
}

// ── Daily View ──

function DailyView() {
  const [entries, setEntries] = useState<DailyEntry[]>([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [newEntry, setNewEntry] = useState('');
  const [project, setProject] = useState('');
  const [tags, setTags] = useState('');
  const [adding, setAdding] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadList() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/memory/daily/list');
      const data = await res.json();
      setEntries(data.entries || []);
    } catch {
      setError('Failed to load daily entries.');
    }
    setLoading(false);
  }

  async function loadEntry(date: string) {
    setSelectedDate(date);
    setError(null);
    try {
      const res = await apiFetch('/api/memory/daily?date=' + encodeURIComponent(date));
      const data = await res.json();
      setContent(data.content || '');
    } catch {
      setError('Failed to load entry.');
    }
  }

  useEffect(() => { loadList(); }, []);

  async function addEntry() {
    if (!newEntry.trim()) return;
    setAdding(true);
    try {
      const tagList = tags.split(',').map(t => t.trim()).filter(Boolean);
      await apiFetch('/api/memory/daily', {
        method: 'POST',
        body: JSON.stringify({ entry: newEntry, project: project || undefined, tags: tagList.length > 0 ? tagList : undefined }),
      });
      setNewEntry('');
      setProject('');
      setTags('');
      setShowForm(false);
      await loadList();
      const today = new Date().toISOString().slice(0, 10);
      await loadEntry(today);
    } catch {
      setError('Failed to add entry.');
    }
    setAdding(false);
  }

  if (loading) return <div class="memory-loading"><span class="loading" /> Loading...</div>;

  return (
    <div class="memory-view">
      <div class="memory-view-header">
        <span class="memory-view-title">Daily</span>
        <div class="memory-view-actions">
          <button class="btn btn-sm btn-primary" onClick={() => setShowForm(!showForm)}>
            <IconPlus size={12} /> Add Entry
          </button>
          <button class="btn btn-sm btn-ghost" onClick={loadList}><IconRefresh size={12} /></button>
        </div>
      </div>

      {showForm && (
        <div class="memory-form">
          <textarea
            class="memory-form-textarea"
            value={newEntry}
            onInput={(e) => setNewEntry((e.target as HTMLTextAreaElement).value)}
            placeholder="What happened? What did you learn?"
            rows={4}
          />
          <div class="memory-form-row">
            <input
              class="memory-form-input"
              value={project}
              onInput={(e) => setProject((e.target as HTMLInputElement).value)}
              placeholder="Project (optional)"
            />
            <input
              class="memory-form-input"
              value={tags}
              onInput={(e) => setTags((e.target as HTMLInputElement).value)}
              placeholder="Tags, comma-separated (optional)"
            />
          </div>
          <div class="memory-form-actions">
            <button class="btn btn-sm btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
            <button class="btn btn-sm btn-primary" onClick={addEntry} disabled={adding || !newEntry.trim()}>
              {adding ? 'Adding...' : 'Add'}
            </button>
          </div>
        </div>
      )}

      {error && <div class="memory-error" role="alert">{error}</div>}

      <div class="memory-split">
        <div class="memory-list">
          {entries.length === 0 && <div class="memory-empty">No daily entries yet.</div>}
          {entries.map(j => (
            <button
              key={j.date}
              class={`memory-list-item${selectedDate === j.date ? ' active' : ''}`}
              onClick={() => loadEntry(j.date)}
            >
              <IconCalendar size={14} />
              <span>{j.date}</span>
            </button>
          ))}
        </div>
        <div class="memory-detail">
          {selectedDate ? (
            <pre class="memory-content">{content || 'Empty entry.'}</pre>
          ) : (
            <div class="memory-empty">Select a daily entry to view.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Decisions View ──

function DecisionsView() {
  const [decisions, setDecisions] = useState<DecisionItem[]>([]);
  const [selectedFilename, setSelectedFilename] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: '', context: '', decision: '', consequences: '', project: '' });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadList() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/memory/decisions/list');
      const data = await res.json();
      setDecisions(data.decisions || []);
    } catch {
      setError('Failed to load decisions.');
    }
    setLoading(false);
  }

  async function loadDecision(filename: string) {
    setSelectedFilename(filename);
    setError(null);
    try {
      const res = await apiFetch('/api/memory/decisions/' + encodeURIComponent(filename));
      const data = await res.json();
      setContent(data.content || '');
    } catch {
      setError('Failed to load decision.');
    }
  }

  useEffect(() => { loadList(); }, []);

  async function create() {
    if (!form.title || !form.context || !form.decision || !form.consequences) return;
    setCreating(true);
    try {
      await apiFetch('/api/memory/decisions/create', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          project: form.project || undefined,
        }),
      });
      setForm({ title: '', context: '', decision: '', consequences: '', project: '' });
      setShowForm(false);
      await loadList();
    } catch {
      setError('Failed to create decision.');
    }
    setCreating(false);
  }

  if (loading) return <div class="memory-loading"><span class="loading" /> Loading...</div>;

  return (
    <div class="memory-view">
      <div class="memory-view-header">
        <span class="memory-view-title">Architecture Decision Records</span>
        <div class="memory-view-actions">
          <button class="btn btn-sm btn-primary" onClick={() => setShowForm(!showForm)}>
            <IconPlus size={12} /> New ADR
          </button>
          <button class="btn btn-sm btn-ghost" onClick={loadList}><IconRefresh size={12} /></button>
        </div>
      </div>

      {showForm && (
        <div class="memory-form">
          <input
            class="memory-form-input full"
            value={form.title}
            onInput={(e) => setForm({ ...form, title: (e.target as HTMLInputElement).value })}
            placeholder="Decision title"
          />
          <textarea
            class="memory-form-textarea"
            value={form.context}
            onInput={(e) => setForm({ ...form, context: (e.target as HTMLTextAreaElement).value })}
            placeholder="Context: Why was this decision needed?"
            rows={3}
          />
          <textarea
            class="memory-form-textarea"
            value={form.decision}
            onInput={(e) => setForm({ ...form, decision: (e.target as HTMLTextAreaElement).value })}
            placeholder="Decision: What was decided?"
            rows={3}
          />
          <textarea
            class="memory-form-textarea"
            value={form.consequences}
            onInput={(e) => setForm({ ...form, consequences: (e.target as HTMLTextAreaElement).value })}
            placeholder="Consequences: What changes as a result?"
            rows={3}
          />
          <input
            class="memory-form-input full"
            value={form.project}
            onInput={(e) => setForm({ ...form, project: (e.target as HTMLInputElement).value })}
            placeholder="Project (optional)"
          />
          <div class="memory-form-actions">
            <button class="btn btn-sm btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
            <button class="btn btn-sm btn-primary" onClick={create} disabled={creating || !form.title || !form.context || !form.decision || !form.consequences}>
              {creating ? 'Creating...' : 'Create ADR'}
            </button>
          </div>
        </div>
      )}

      {error && <div class="memory-error" role="alert">{error}</div>}

      <div class="memory-split">
        <div class="memory-list">
          {decisions.length === 0 && <div class="memory-empty">No decisions recorded yet.</div>}
          {decisions.map(d => (
            <button
              key={d.filename}
              class={`memory-list-item${selectedFilename === d.filename ? ' active' : ''}`}
              onClick={() => loadDecision(d.filename)}
            >
              <IconBookmark size={14} />
              <div class="memory-list-item-info">
                <span class="memory-list-item-title">{d.title}</span>
                <span class="memory-list-item-meta">{d.date}</span>
              </div>
            </button>
          ))}
        </div>
        <div class="memory-detail">
          {selectedFilename !== null ? (
            <pre class="memory-content">{content || 'Empty decision.'}</pre>
          ) : (
            <div class="memory-empty">Select a decision to view.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Paths View ──

function PathsView() {
  const [paths, setPaths] = useState<PathScope[]>([]);
  const [selected, setSelected] = useState<PathScope | null>(null);
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function loadList() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/memory/paths');
      const data = await res.json();
      setPaths(data.paths || []);
    } catch {
      setError('Failed to load path scopes.');
    }
    setLoading(false);
  }

  async function loadPath(p: PathScope) {
    setSelected(p);
    setEditing(false);
    setError(null);
    try {
      const res = await apiFetch('/api/memory/paths/' + encodeURIComponent(p.pathId));
      const data = await res.json();
      setContent(data.content || '');
      setEditContent(data.content || '');
    } catch {
      setError('Failed to load path memory.');
    }
  }

  useEffect(() => { loadList(); }, []);

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      await apiFetch('/api/memory/paths/' + encodeURIComponent(selected.pathId), {
        method: 'PUT',
        body: JSON.stringify({ content: editContent }),
      });
      setContent(editContent);
      setEditing(false);
      setMsg('Saved');
      setTimeout(() => setMsg(''), 2000);
    } catch {
      setMsg('Save failed');
    }
    setSaving(false);
  }

  if (loading) return <div class="memory-loading"><span class="loading" /> Loading...</div>;

  return (
    <div class="memory-view">
      <div class="memory-view-header">
        <span class="memory-view-title">Path-scoped Memory</span>
        <div class="memory-view-actions">
          {selected && (
            <>
              {msg && <span class={`config-save-msg ${msg === 'Saved' ? 'success' : 'error'}`}>{msg}</span>}
              {editing ? (
                <>
                  <button class="btn btn-sm btn-secondary" onClick={() => { setEditing(false); setEditContent(content); }}>Cancel</button>
                  <button class="btn btn-sm btn-primary" onClick={save} disabled={saving}>
                    <IconSave size={12} /> {saving ? 'Saving...' : 'Save'}
                  </button>
                </>
              ) : (
                <button class="btn btn-sm btn-secondary" onClick={() => setEditing(true)}>
                  <IconEdit size={12} /> Edit
                </button>
              )}
            </>
          )}
          <button class="btn btn-sm btn-ghost" onClick={loadList}><IconRefresh size={12} /></button>
        </div>
      </div>

      {error && <div class="memory-error" role="alert">{error}</div>}

      <div class="memory-split">
        <div class="memory-list">
          {paths.length === 0 && <div class="memory-empty">No path-scoped memory yet.</div>}
          {paths.map(p => (
            <button
              key={p.pathId}
              class={`memory-list-item${selected?.pathId === p.pathId ? ' active' : ''}`}
              onClick={() => loadPath(p)}
            >
              <IconFolder size={14} />
              <div class="memory-list-item-info">
                <span class="memory-list-item-title">{p.name}</span>
                <span class="memory-list-item-meta">{p.pathId}</span>
              </div>
            </button>
          ))}
        </div>
        <div class="memory-detail">
          {selected ? (
            editing ? (
              <textarea
                class="memory-editor"
                value={editContent}
                onInput={(e) => setEditContent((e.target as HTMLTextAreaElement).value)}
                spellcheck={false}
              />
            ) : (
              <pre class="memory-content">{content || 'Empty path memory.'}</pre>
            )
          ) : (
            <div class="memory-empty">Select a path scope to view its memory.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Search View ──

interface SearchResultItem {
  content: string;
  filePath: string;
  fileType: string;
  snippet: string;
  rank: number;
}

function SearchView() {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<string[]>([]);
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchAvailable, setSearchAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scopes = ['durable', 'daily', 'decision', 'path', 'session'];

  function toggleScope(s: string) {
    setScope(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  }

  async function doSearch(q: string, s: string[]) {
    if (!q.trim()) { setResults([]); setError(null); return; }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearching(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q });
      if (s.length > 0) params.set('scope', s.join(','));
      const res = await apiFetch('/api/memory/search?' + params.toString(), { signal: controller.signal });
      const data = await res.json();
      setSearchAvailable(data.available !== false);
      setResults(data.results || []);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError('Search failed. Please try again.');
    }
    setSearching(false);
  }

  function handleInput(q: string) {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(q, scope), 300);
  }

  useEffect(() => {
    if (query.trim()) doSearch(query, scope);
  }, [scope]);

  // Cleanup debounce timer and abort controller on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  if (!searchAvailable) {
    return (
      <div class="memory-view">
        <div class="memory-empty">
          Search is not available. The SQLite indexer requires the Docker container to be running.
        </div>
      </div>
    );
  }

  return (
    <div class="memory-view">
      <div class="memory-search-bar">
        <IconSearch size={16} />
        <input
          class="memory-search-input"
          value={query}
          onInput={(e) => handleInput((e.target as HTMLInputElement).value)}
          placeholder="Search memory..."
          type="text"
        />
        {searching && <span class="loading" />}
      </div>

      <div class="memory-scope-pills">
        {scopes.map(s => (
          <button
            key={s}
            class={`memory-scope-pill${scope.includes(s) ? ' active' : ''}`}
            onClick={() => toggleScope(s)}
          >
            {s}
          </button>
        ))}
      </div>

      {results.length > 0 && (
        <div class="memory-search-results">
          {results.map((r, i) => (
            <div key={i} class="memory-search-result">
              <div class="memory-search-result-header">
                <span class={`memory-type-badge ${r.fileType}`}>{r.fileType}</span>
                <span class="memory-search-result-path">{r.filePath}</span>
              </div>
              <div
                class="memory-search-result-snippet"
                dangerouslySetInnerHTML={{ __html: sanitizeSnippet(r.snippet) }}
              />
            </div>
          ))}
        </div>
      )}

      {error && <div class="memory-error" role="alert">{error}</div>}

      {query.trim() && !searching && !error && results.length === 0 && (
        <div class="memory-empty">No results for "{query}".</div>
      )}
    </div>
  );
}

// ── Main Section ──

export function MemorySection() {
  const [tab, setTab] = useState<MemoryTab>('durable');

  const tabs: { id: MemoryTab; label: string }[] = [
    { id: 'durable', label: 'Durable' },
    { id: 'daily', label: 'Daily' },
    { id: 'decisions', label: 'Decisions' },
    { id: 'paths', label: 'Paths' },
    { id: 'search', label: 'Search' },
  ];

  return (
    <div class="content-section">
      <div class="memory-container">
        <div class="memory-tabs">
          {tabs.map(t => (
            <button
              key={t.id}
              class={`memory-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div class="memory-tab-content">
          {tab === 'durable' && <DurableView />}
          {tab === 'daily' && <DailyView />}
          {tab === 'decisions' && <DecisionsView />}
          {tab === 'paths' && <PathsView />}
          {tab === 'search' && <SearchView />}
        </div>
      </div>
    </div>
  );
}
