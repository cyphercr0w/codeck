import { useState, useEffect, useMemo } from 'preact/hooks';
import { apiFetch } from '../api';
import { wsSend } from '../ws';
import {
  workspacePath, sessions, activeSessionId, showToast,
  type TerminalSession,
} from '../state/store';
import { IconRefresh, IconFlow, IconPlug } from './Icons';

// ── Unified diff parser ──

type LineKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx';
interface DiffLine { kind: LineKind; text: string; newNo: number | null; }
interface DiffFile { file: string; lines: DiffLine[]; }

function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let inHunk = false;
  let newNo = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git')) {
      cur = { file: '', lines: [] };
      files.push(cur);
      inHunk = false;
      // Provisional name from the "b/<path>" side — survives deletions
      // (+++ /dev/null), pure renames, and binary changes (no +++/--- hunk).
      const m = line.match(/ b\/(.+)$/);
      if (m) cur.file = m[1];
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+++ ')) {
      const f = line.slice(4).replace(/^b\//, '');
      if (f && f !== '/dev/null') cur.file = f;
      cur.lines.push({ kind: 'meta', text: line, newNo: null });
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(/\+(\d+)/);
      newNo = m ? parseInt(m[1], 10) : 0;
      inHunk = true;
      cur.lines.push({ kind: 'hunk', text: line, newNo: null });
      continue;
    }
    if (!inHunk) {
      cur.lines.push({ kind: 'meta', text: line, newNo: null });
      continue;
    }
    // "\ No newline at end of file" is a marker, not a code line — don't count it.
    if (line.startsWith('\\')) {
      cur.lines.push({ kind: 'meta', text: line, newNo: null });
      continue;
    }
    if (line.startsWith('+')) { cur.lines.push({ kind: 'add', text: line.slice(1), newNo }); newNo++; continue; }
    if (line.startsWith('-')) { cur.lines.push({ kind: 'del', text: line.slice(1), newNo: null }); continue; }
    cur.lines.push({ kind: 'ctx', text: line.slice(1), newNo }); newNo++;
  }
  return files.filter(f => f.file);
}

// ── Changes tab (diff review → reprompt agent) ──

interface Annotation { file: string; no: number | null; text: string; }

interface RepoOption { name: string; path: string; }

function ChangesTab() {
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [base, setBase] = useState<'HEAD' | 'staged' | 'working'>('HEAD');
  const [annotations, setAnnotations] = useState<Record<string, Annotation>>({});
  const [editing, setEditing] = useState<string | null>(null);

  // The workspace root usually isn't a git repo — repos live in subdirectories.
  // Pick a concrete repo to diff against instead of the (non-repo) workspace root.
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [reposLoaded, setReposLoaded] = useState(false);
  const [repoPath, setRepoPath] = useState('');

  const agentSessions = sessions.value.filter((s: TerminalSession) => s.type === 'agent');
  const defaultSession = agentSessions.find(s => s.id === activeSessionId.value) || agentSessions[0];
  const [sessionId, setSessionId] = useState<string>(defaultSession?.id || '');

  const repoName = repos.find(r => r.path === repoPath)?.name || '';

  async function loadRepos() {
    try {
      const res = await apiFetch('/api/git/repos');
      const data = await res.json();
      const list: RepoOption[] = data.repos || [];
      setRepos(list);
      if (list.length && !repoPath) setRepoPath(list[0].path);
    } catch { /* ignore — empty state handles it */ }
    setReposLoaded(true);
  }

  async function load() {
    if (!repoPath) { setRaw(null); return; }
    setLoading(true);
    setError('');
    // Line-index keys (fi:li) reindex when the diff reloads — drop stale annotations
    // so a comment can never attach to the wrong line after a scope switch/refresh.
    setAnnotations({});
    setEditing(null);
    try {
      const params = new URLSearchParams({ cwd: repoPath });
      if (base === 'staged') params.set('staged', 'true');
      else if (base === 'HEAD') params.set('base', 'HEAD');
      const res = await apiFetch(`/api/git/diff?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to load diff'); setRaw(null); }
      else { setRaw(data.diff || ''); }
    } catch { setError('Failed to load diff'); }
    setLoading(false);
  }

  useEffect(() => { loadRepos(); }, []);
  useEffect(() => { load(); }, [base, repoPath]);

  // Keep the session selection valid as sessions hydrate/appear after mount.
  useEffect(() => {
    if (!sessionId && agentSessions.length) setSessionId(agentSessions[0].id);
  }, [agentSessions.length]);

  const files = useMemo(() => parseDiff(raw || ''), [raw]);
  const pending = Object.values(annotations).filter(a => a.text.trim());

  function sendToAgent() {
    const sid = sessionId || agentSessions.find(s => s.id === activeSessionId.value)?.id || agentSessions[0]?.id;
    if (!sid) { showToast('Open a Terminal (agent) session first', 'error'); return; }
    if (pending.length === 0) return;
    const body = pending
      // Collapse embedded newlines — a PTY submits on newline, so the reprompt must be one line.
      .map(a => `${a.file}${a.no ? `:${a.no}` : ''} — ${a.text.replace(/\s+/g, ' ').trim()}`)
      .join('; ');
    const prompt = `Please address these code-review comments on the current uncommitted changes: ${body}. Apply the fixes, then re-run verification.`;
    wsSend({ type: 'console:input', sessionId: sid, data: prompt + '\r' });
    showToast(`Sent ${pending.length} comment(s) to the agent`, 'success');
    setAnnotations({});
    setEditing(null);
  }

  if (!reposLoaded) {
    return <div class="dash-meta" style="text-align: center; padding: 24px">Loading repositories…</div>;
  }

  if (repos.length === 0) {
    return (
      <div class="empty-state">
        <IconFlow size={36} style="color: var(--text-muted); margin-bottom: 12px" />
        <h3>No git repositories</h3>
        <p>No git repository was found in <code>{workspacePath.value}</code>. Clone a repo or run <code>git init</code> in a project folder, then refresh.</p>
        <button class="btn btn-sm btn-secondary" style="margin-top: 12px" onClick={loadRepos}><IconRefresh size={14} /> Refresh</button>
      </div>
    );
  }

  return (
    <div>
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap">
        {repos.length > 1 && (
          <select class="input" style="width: auto; padding: 4px 8px" value={repoPath} onChange={e => setRepoPath((e.target as HTMLSelectElement).value)} title="Repository">
            {repos.map(r => <option key={r.path} value={r.path}>{r.name === '.' ? 'workspace (root)' : r.name}</option>)}
          </select>
        )}
        <div class="schedule-presets">
          {(['HEAD', 'staged', 'working'] as const).map(b => (
            <button key={b} type="button" class={`btn btn-xs ${base === b ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setBase(b)}>
              {b === 'HEAD' ? 'All changes' : b === 'staged' ? 'Staged' : 'Working tree'}
            </button>
          ))}
        </div>
        <button class="btn btn-xs btn-ghost" onClick={load}><IconRefresh size={14} /></button>
        <div style="margin-left: auto; display: flex; align-items: center; gap: 8px">
          {agentSessions.length > 0 && (
            <select class="input" style="width: auto; padding: 4px 8px" value={sessionId} onChange={e => setSessionId((e.target as HTMLSelectElement).value)}>
              {agentSessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          <button class="btn btn-sm btn-primary" disabled={pending.length === 0} onClick={sendToAgent}>
            Send {pending.length > 0 ? `${pending.length} ` : ''}to agent
          </button>
        </div>
      </div>

      {error && <div class="alert alert-error" style="margin-bottom: 12px">{error}</div>}
      {loading && <div class="dash-meta" style="text-align: center; padding: 24px">Loading diff…</div>}
      {!loading && !error && files.length === 0 && (
        <div class="empty-state"><IconFlow size={36} style="color: var(--text-muted); margin-bottom: 12px" /><h3>No changes</h3><p>Nothing to review in <code>{repoName === '.' ? 'workspace (root)' : repoName || 'this repository'}</code>. Make some edits (or switch scope above).</p></div>
      )}

      {files.map((f, fi) => (
        <div key={f.file} class="dash-card" style="padding: 0; overflow: hidden; margin-bottom: 12px">
          <div class="dash-card-title" style="margin: 0; padding: 8px 12px; border-bottom: 1px solid var(--border)"><code>{f.file}</code></div>
          <div style="overflow-x: auto; font-family: var(--font-mono, monospace); font-size: 12.5px">
            {f.lines.map((ln, li) => {
              const key = `${fi}:${li}`;
              const annotatable = ln.kind === 'add' || ln.kind === 'ctx';
              const bg = ln.kind === 'add' ? 'rgba(46,160,67,0.12)' : ln.kind === 'del' ? 'rgba(248,81,73,0.12)' : ln.kind === 'hunk' ? 'rgba(88,166,255,0.10)' : 'transparent';
              const color = ln.kind === 'meta' || ln.kind === 'hunk' ? 'var(--text-muted)' : 'var(--text-primary)';
              const ann = annotations[key];
              return (
                <div key={key}>
                  <div
                    style={`display: flex; gap: 8px; padding: 1px 8px; white-space: pre; background: ${bg}; color: ${color}; ${annotatable ? 'cursor: pointer' : ''}`}
                    onClick={annotatable ? () => setEditing(editing === key ? null : key) : undefined}
                    title={annotatable ? 'Click to comment' : undefined}
                  >
                    <span style="opacity: 0.4; min-width: 42px; text-align: right; user-select: none">{ln.newNo ?? ''}</span>
                    <span style="opacity: 0.5; user-select: none">{ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : ' '}</span>
                    <span>{ln.text || ' '}</span>
                    {ann?.text?.trim() && <span class="badge badge-info" style="margin-left: auto">💬</span>}
                  </div>
                  {editing === key && (
                    <div style="padding: 6px 12px; background: var(--surface-2, rgba(255,255,255,0.03))">
                      <textarea
                        class="input"
                        placeholder={`Comment on ${f.file}:${ln.newNo ?? ''}`}
                        value={ann?.text || ''}
                        rows={2}
                        style="resize: vertical; font-family: inherit"
                        onInput={e => {
                          const text = (e.target as HTMLTextAreaElement).value;
                          setAnnotations(a => ({ ...a, [key]: { file: f.file, no: ln.newNo, text } }));
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── GitHub tab (PRs / issues) ──

interface RepoRef { name: string; owner: string; repo: string; }
interface PullRequest { number: number; title: string; state: string; draft: boolean; user: string | null; url: string; updatedAt: string; branch: string | null; base: string | null; }
interface IssueItem { number: number; title: string; state: string; user: string | null; url: string; updatedAt: string; comments: number; labels: string[]; }

function GitHubTab() {
  const [repos, setRepos] = useState<RepoRef[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [kind, setKind] = useState<'pulls' | 'issues'>('pulls');
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const [pulls, setPulls] = useState<PullRequest[]>([]);
  const [issues, setIssues] = useState<IssueItem[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { loadRepos(); }, []);
  useEffect(() => { if (selected) loadItems(); }, [selected, kind, state]);

  async function loadRepos() {
    try {
      const res = await apiFetch('/api/github/repos');
      const data = await res.json();
      const list: RepoRef[] = data.repos || [];
      setRepos(list);
      if (list.length && !selected) setSelected(`${list[0].owner}/${list[0].repo}`);
    } catch { /* ignore */ }
  }

  async function loadItems() {
    const [owner, repo] = selected.split('/');
    if (!owner || !repo) return;
    setLoading(true); setError('');
    try {
      const res = await apiFetch(`/api/github/${owner}/${repo}/${kind}?state=${state}`);
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed'); setPulls([]); setIssues([]); }
      else if (kind === 'pulls') setPulls(data.pulls || []);
      else setIssues(data.issues || []);
    } catch { setError('Failed to load'); }
    setLoading(false);
  }

  if (repos.length === 0) {
    return (
      <div class="empty-state">
        <IconPlug size={36} style="color: var(--text-muted); margin-bottom: 12px" />
        <h3>No GitHub repos</h3>
        <p>No workspace repository has a GitHub <code>origin</code> remote, or you're not signed in with <code>gh</code>. Connect GitHub in Integrations.</p>
      </div>
    );
  }

  const items = kind === 'pulls' ? pulls : issues;

  return (
    <div>
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap">
        <select class="input" style="width: auto; padding: 4px 8px" value={selected} onChange={e => setSelected((e.target as HTMLSelectElement).value)}>
          {repos.map(r => <option key={`${r.owner}/${r.repo}`} value={`${r.owner}/${r.repo}`}>{r.owner}/{r.repo}</option>)}
        </select>
        <div class="schedule-presets">
          <button type="button" class={`btn btn-xs ${kind === 'pulls' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setKind('pulls')}>Pull Requests</button>
          <button type="button" class={`btn btn-xs ${kind === 'issues' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setKind('issues')}>Issues</button>
        </div>
        <select class="input" style="width: auto; padding: 4px 8px" value={state} onChange={e => setState((e.target as HTMLSelectElement).value as any)}>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </select>
        <button class="btn btn-xs btn-ghost" onClick={loadItems}><IconRefresh size={14} /></button>
      </div>

      {error && <div class="alert alert-error" style="margin-bottom: 12px">{error}</div>}
      {loading && <div class="dash-meta" style="text-align: center; padding: 24px">Loading…</div>}
      {!loading && !error && items.length === 0 && (
        <div class="dash-meta" style="text-align: center; padding: 24px">No {kind === 'pulls' ? 'pull requests' : 'issues'} ({state})</div>
      )}

      {!loading && items.length > 0 && (
        <div class="dash-card" style="padding: 0; overflow: hidden">
          {kind === 'pulls' && pulls.map((p, i) => (
            <a key={p.number} href={p.url} target="_blank" rel="noopener noreferrer" class="execution-item" style={`text-decoration: none; color: inherit; ${i > 0 ? 'border-top: 1px solid var(--border)' : ''}`}>
              <span class={`badge ${p.draft ? 'badge-muted' : p.state === 'open' ? 'badge-success' : 'badge-error'}`}>{p.draft ? 'draft' : p.state}</span>
              <span style="font-size: 13px">#{p.number} {p.title}</span>
              <span style="color: var(--text-muted); font-size: 12px; margin-left: auto">{p.user} · {p.branch}</span>
            </a>
          ))}
          {kind === 'issues' && issues.map((it, i) => (
            <a key={it.number} href={it.url} target="_blank" rel="noopener noreferrer" class="execution-item" style={`text-decoration: none; color: inherit; ${i > 0 ? 'border-top: 1px solid var(--border)' : ''}`}>
              <span class={`badge ${it.state === 'open' ? 'badge-success' : 'badge-error'}`}>{it.state}</span>
              <span style="font-size: 13px">#{it.number} {it.title}</span>
              <span style="color: var(--text-muted); font-size: 12px; margin-left: auto">{it.user}{it.comments ? ` · 💬 ${it.comments}` : ''}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main ──

export function ScmSection() {
  const [tab, setTab] = useState<'changes' | 'github'>('changes');

  return (
    <div class="content-section">
      <div class="home-content">
        <div class="home-header">
          <div>
            <div class="home-title"><IconFlow size={20} /><span>Source Control</span></div>
            <p class="home-subtitle">Review local changes and send comments to the agent, or browse GitHub PRs & issues</p>
          </div>
          <div class="schedule-presets">
            <button type="button" class={`btn btn-sm ${tab === 'changes' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('changes')}>Changes</button>
            <button type="button" class={`btn btn-sm ${tab === 'github' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('github')}>GitHub</button>
          </div>
        </div>
        {tab === 'changes' ? <ChangesTab /> : <GitHubTab />}
      </div>
    </div>
  );
}
