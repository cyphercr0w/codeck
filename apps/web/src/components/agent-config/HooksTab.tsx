import { useEffect, useState } from 'preact/hooks';
import { apiFetch } from '../../api';
import { showToast } from '../../state/store';
import { IconPlus, IconX } from '../Icons';
import { ConfirmModal } from '../ConfirmModal';

interface HookEntry {
  matcher: string;
  hooks: { type: string; command: string }[];
}

type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop' | 'PostCompact';

const HOOK_EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'Stop', 'PostCompact'];

const EVENT_DESCRIPTIONS: Record<HookEvent, string> = {
  PreToolUse: 'Runs before tool execution (validation, guards)',
  PostToolUse: 'Runs after tool execution (formatting, checks)',
  Stop: 'Runs when the session ends (cleanup, memory save)',
  PostCompact: 'Runs after context compaction (re-inject memory)',
};

export function HooksTab() {
  const [hooks, setHooks] = useState<Record<string, HookEntry[]>>({});
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ event: string; index: number } | null>(null);

  // Add form
  const [newEvent, setNewEvent] = useState<HookEvent>('PreToolUse');
  const [newMatcher, setNewMatcher] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => { loadHooks(); }, []);

  async function loadHooks() {
    try {
      const res = await apiFetch('/api/hooks');
      const data = await res.json();
      setHooks(data.hooks || {});
    } catch {
      showToast('Failed to load hooks', 'error');
    }
    setLoading(false);
  }

  async function handleAdd() {
    if (!newCommand.trim()) return;
    setAdding(true);
    try {
      const res = await apiFetch('/api/hooks', {
        method: 'POST',
        body: JSON.stringify({
          event: newEvent,
          matcher: newMatcher.trim(),
          command: newCommand.trim(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        showToast('Hook added', 'success');
        setNewMatcher('');
        setNewCommand('');
        setAddOpen(false);
        await loadHooks();
      } else {
        showToast(data.error || 'Add failed', 'error');
      }
    } catch {
      showToast('Connection error', 'error');
    }
    setAdding(false);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      const res = await apiFetch('/api/hooks', {
        method: 'DELETE',
        body: JSON.stringify(deleteTarget),
      });
      const data = await res.json();
      if (data.success) {
        showToast('Hook removed', 'success');
        await loadHooks();
      } else {
        showToast(data.error || 'Delete failed', 'error');
      }
    } catch {
      showToast('Connection error', 'error');
    }
    setDeleteTarget(null);
  }

  // Flatten hooks into displayable rows
  function flattenHooks(event: string): { matcher: string; command: string; index: number }[] {
    const entries = hooks[event] || [];
    return entries.map((entry, idx) => ({
      matcher: entry.matcher || '(all)',
      command: entry.hooks?.[0]?.command || 'unknown',
      index: idx,
    }));
  }

  return (
    <div class="ac-tab-content">
      <div class="ac-section">
        <div class="ac-section-header">
          <div class="ac-section-title">Hooks</div>
          <button class="btn btn-xs btn-primary" onClick={() => setAddOpen(o => !o)}>
            <IconPlus size={11} /> Add Hook
          </button>
        </div>

        {addOpen && (
          <div class="ac-add-form">
            <select class="ac-input" value={newEvent} onChange={e => setNewEvent((e.target as HTMLSelectElement).value as HookEvent)}>
              {HOOK_EVENTS.map(ev => (
                <option key={ev} value={ev}>{ev}</option>
              ))}
            </select>
            <input class="ac-input" placeholder="Matcher (e.g. Edit|Write, leave empty for all)" value={newMatcher} onInput={e => setNewMatcher((e.target as HTMLInputElement).value)} />
            <input class="ac-input" placeholder="Command (e.g. node /path/to/script.mjs)" value={newCommand} onInput={e => setNewCommand((e.target as HTMLInputElement).value)} />
            <div class="ac-add-form-actions">
              <button class="btn btn-xs btn-ghost" onClick={() => setAddOpen(false)}>Cancel</button>
              <button class="btn btn-xs btn-primary" onClick={handleAdd} disabled={adding || !newCommand.trim()}>
                {adding ? <span class="spinner-sm" /> : 'Add'}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div class="ac-empty"><span class="spinner-sm" /> Loading...</div>
        ) : (
          <div class="ac-hooks-grid">
            {HOOK_EVENTS.map(event => {
              const rows = flattenHooks(event);
              return (
                <div key={event} class="ac-hook-group">
                  <div class="ac-hook-group-header">
                    <span class="ac-hook-event">{event}</span>
                    <span class="ac-hook-desc">{EVENT_DESCRIPTIONS[event]}</span>
                  </div>
                  {rows.length === 0 ? (
                    <div class="ac-hook-empty">No hooks</div>
                  ) : (
                    rows.map(row => (
                      <div key={`${event}-${row.index}`} class="ac-hook-row">
                        <div class="ac-hook-row-info">
                          <span class="ac-hook-matcher">{row.matcher}</span>
                          <span class="ac-hook-command">{row.command}</span>
                        </div>
                        <button class="btn btn-xs btn-ghost" onClick={() => setDeleteTarget({ event, index: row.index })} title="Remove">
                          <IconX size={12} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmModal
        visible={deleteTarget !== null}
        title="Remove Hook"
        message="Remove this hook? The agent will no longer run this command."
        confirmLabel="Remove"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
