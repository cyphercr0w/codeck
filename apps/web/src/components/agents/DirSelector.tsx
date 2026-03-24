import { useState, useEffect } from 'preact/hooks';
import { apiFetch } from '../../api';
import { workspacePath } from '../../state/store';
import { IconFolder, IconFolderOpen, IconChevronLeft } from '../Icons';

interface DirEntry { name: string; path: string; }

// ── Directory Cache ──

const DIR_CACHE_TTL = 30_000;
const dirCache = new Map<string, { entries: DirEntry[]; ts: number }>();

function getCachedDirs(path: string): DirEntry[] | null {
  const cached = dirCache.get(path);
  if (!cached) return null;
  if (Date.now() - cached.ts >= DIR_CACHE_TTL) {
    dirCache.delete(path);
    return null;
  }
  return cached.entries;
}

function setCachedDirs(path: string, entries: DirEntry[]): void {
  dirCache.set(path, { entries, ts: Date.now() });
}

async function fetchDirs(relPath: string): Promise<DirEntry[]> {
  const cached = getCachedDirs(relPath);
  if (cached) return cached;

  try {
    const res = await apiFetch(`/api/files?path=${encodeURIComponent(relPath)}&type=dir`);
    const data = await res.json();
    const entries: DirEntry[] = (data.items || []).map((e: { name: string }) => ({
      name: e.name,
      path: relPath ? `${relPath}/${e.name}` : e.name,
    }));
    setCachedDirs(relPath, entries);
    return entries;
  } catch {
    return [];
  }
}

// ── Directory Selector Component ──

export function DirSelector({ value, onChange }: {
  value: string;
  onChange: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [relativePath, setRelativePath] = useState('');
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const ws = workspacePath.value;

  useEffect(() => { fetchDirs(''); }, []);

  useEffect(() => {
    if (open) loadDirs(relativePath);
  }, [open, relativePath]);

  function toAbsolute(rel: string): string {
    return rel ? `${ws}/${rel}` : ws;
  }

  async function loadDirs(relPath: string) {
    const cached = getCachedDirs(relPath);
    if (cached) {
      setDirs(cached);
      setLoading(false);
      for (const entry of cached) fetchDirs(entry.path);
      return;
    }

    setLoading(true);
    const entries = await fetchDirs(relPath);
    setDirs(entries);
    setLoading(false);
    for (const entry of entries) fetchDirs(entry.path);
  }

  function handleSelect(relPath: string) {
    onChange(toAbsolute(relPath));
    setOpen(false);
  }

  function handleNavigate(relPath: string) {
    setRelativePath(relPath);
  }

  function handleParent() {
    const parts = relativePath.split('/').filter(Boolean);
    parts.pop();
    setRelativePath(parts.join('/'));
  }

  const displayPath = toAbsolute(relativePath);

  return (
    <div class="dir-selector">
      <div class="dir-selector-row">
        <input
          type="text"
          class="input"
          value={value}
          onInput={e => onChange((e.target as HTMLInputElement).value)}
          placeholder={`${ws} (default)`}
        />
        <button class="btn btn-xs btn-secondary" type="button" onClick={() => setOpen(!open)} title="Browse directories">
          {open ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
        </button>
      </div>
      {open && (
        <div class="dir-selector-list">
          <div class="dir-selector-header">
            <button class="btn btn-xs btn-ghost" onClick={handleParent} disabled={!relativePath}>
              <IconChevronLeft size={12} /> Up
            </button>
            <span class="dir-selector-path">{displayPath}</span>
            <button class="btn btn-xs btn-primary" onClick={() => handleSelect(relativePath)}>
              Select
            </button>
          </div>
          {loading ? (
            <div class="dir-selector-empty"><span class="loading" /> Loading...</div>
          ) : dirs.length === 0 ? (
            <div class="dir-selector-empty">No subdirectories</div>
          ) : (
            dirs.map(d => (
              <div key={d.path} class="dir-selector-item" onClick={() => handleNavigate(d.path)}>
                <IconFolder size={14} />
                <span>{d.name}</span>
                <button class="btn btn-xs btn-ghost" onClick={e => { e.stopPropagation(); handleSelect(d.path); }}>
                  Select
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
