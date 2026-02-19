import { useEffect, useRef, useState } from 'preact/hooks';
import { sessions, activeSessionId, setActiveSessionId, addLocalLog, addSession, removeSession, renameSession, agentName, isMobile } from '../state/store';
import { apiFetch } from '../api';
import { createTerminal, destroyTerminal, fitTerminal, focusTerminal, writeToTerminal } from '../terminal';
import { wsSend, setTerminalHandlers, attachSession } from '../ws';
import { IconPlus, IconX, IconShell, IconTerminal } from './Icons';
import { MobileTerminalToolbar } from './MobileTerminalToolbar';

interface ClaudeSectionProps {
  onNewSession: () => void;
  onNewShell: () => void;
}

export function ClaudeSection({ onNewSession, onNewShell }: ClaudeSectionProps) {
  const instancesRef = useRef<HTMLDivElement>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const sessionList = sessions.value;
  const activeId = activeSessionId.value;

  // Register terminal handlers for WS output/exit
  useEffect(() => {
    setTerminalHandlers(
      (sessionId, data) => writeToTerminal(sessionId, data),
      (sessionId) => {
        // Find session name before removing
        const session = sessions.value.find(s => s.id === sessionId);
        const cwdShort = session ? session.name : sessionId;

        // Notify if tab is hidden
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          new Notification('Codeck', { body: `Terminal "${cwdShort}" finished` });
        }

        addLocalLog('info', 'Session exited: ' + sessionId);
        destroyTerminal(sessionId);
        const el = document.getElementById('term-' + sessionId);
        if (el) el.remove();
        removeSession(sessionId);
      },
    );
  }, []);

  // Mount terminals for restored sessions that don't have DOM elements yet (after F5 or restore)
  useEffect(() => {
    const container = instancesRef.current;
    if (!container) return;

    for (const s of sessionList) {
      if (s.loading) continue;
      if (document.getElementById('term-' + s.id)) continue;

      const el = document.createElement('div');
      el.className = 'terminal-instance';
      el.id = 'term-' + s.id;
      container.appendChild(el);

      const instance = createTerminal(s.id, el);

      attachSession(s.id);
      wsSend({ type: 'console:resize', sessionId: s.id, cols: instance.term.cols, rows: instance.term.rows });
    }

  }, [sessionList.length]);

  // Toggle visible terminal when active tab changes
  useEffect(() => {
    const container = instancesRef.current;
    if (!container || !activeId) return;

    container.querySelectorAll('.terminal-instance').forEach(el => el.classList.remove('active'));
    const activeEl = document.getElementById('term-' + activeId);
    if (activeEl) activeEl.classList.add('active');
    setTimeout(() => {
      fitTerminal(activeId);
      focusTerminal(activeId);
    }, 50);
  }, [activeId]);

  function startEditingTab(id: string, currentName: string) {
    setEditingTabId(id);
    setEditValue(currentName);
    setTimeout(() => editInputRef.current?.select(), 0);
  }

  function commitEdit(id: string) {
    const trimmed = editValue.trim();
    if (trimmed && editingTabId === id) {
      renameSession(id, trimmed);
      apiFetch('/api/console/rename', {
        method: 'POST',
        body: JSON.stringify({ sessionId: id, name: trimmed }),
      }).catch(() => {});
    }
    setEditingTabId(null);
  }

  function cancelEdit() {
    setEditingTabId(null);
  }

  function switchToSession(id: string) {
    setActiveSessionId(id);
    setTimeout(() => {
      fitTerminal(id);
      focusTerminal(id);
    }, 50);
  }

  function closeSession(id: string) {
    apiFetch('/api/console/destroy', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id }),
    }).catch(() => {});
    destroyTerminal(id);
    const el = document.getElementById('term-' + id);
    if (el) el.remove();
    removeSession(id);
  }

  // On mobile, tapping the terminal area focuses the hidden input (keyboard capture)
  function handleTerminalTap(e: MouseEvent) {
    if (!isMobile.value) return;
    const target = e.target as HTMLElement;
    // Don't steal focus from toolbar buttons
    if (target.closest('.mobile-toolbar')) return;
    document.getElementById('mobile-hidden-input')?.focus();
  }

  const mobile = isMobile.value;

  return (
    <div class="content-section">
      <div class={`claude-content${mobile ? ' mobile-terminal' : ''}`}>
        <div class="terminal-tabs">
          {sessionList.map(s => (
              <button
                key={s.id}
                class={`terminal-tab${s.id === activeId ? ' active' : ''}${s.loading ? ' loading' : ''}${s.type === 'shell' ? ' shell' : ''}`}
                onClick={() => !s.loading && switchToSession(s.id)}
                title={s.cwd}
              >
                {s.loading ? (
                  <span class="terminal-tab-loading">
                    <span class="spinner-sm" />
                    {s.name}
                  </span>
                ) : editingTabId === s.id ? (
                  <input
                    ref={editInputRef}
                    class="terminal-tab-edit"
                    value={editValue}
                    onInput={(e) => setEditValue((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit(s.id);
                      if (e.key === 'Escape') cancelEdit();
                    }}
                    onBlur={() => commitEdit(s.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span onDblClick={(e) => { e.stopPropagation(); startEditingTab(s.id, s.name); }}>
                    {s.type === 'shell' && <span class="tab-shell-badge"><IconShell size={12} /></span>}
                    {s.name}
                  </span>
                )}
                {!s.loading && (
                  <button
                    class="terminal-tab-close"
                    aria-label={`Close ${s.name} session`}
                    onClick={(e) => { e.stopPropagation(); closeSession(s.id); }}
                  >
                    <IconX size={12} />
                  </button>
                )}
              </button>
            ))}
          <button
            class="terminal-tab-new"
            aria-label="New Agent Session"
            disabled={sessionList.length >= 5}
            onClick={onNewSession}
          >
            <IconPlus size={14} />
          </button>
          <button
            class="terminal-tab-new shell"
            aria-label="New Shell"
            disabled={sessionList.length >= 5}
            onClick={onNewShell}
          >
            <IconShell size={14} />
          </button>
        </div>
        <div
          class="terminal-instances"
          ref={instancesRef}
          onClick={handleTerminalTap}
        >
          {sessionList.length === 0 && (
            <div class="claude-empty">
              <div class="claude-empty-icon"><IconTerminal size={48} /></div>
              <div class="claude-empty-title">{agentName.value} CLI Console</div>
              <div class="claude-empty-desc">{mobile ? 'Tap + to start a session' : 'Click + to start a new session'}</div>
            </div>
          )}
          {activeId && sessionList.find(s => s.id === activeId)?.loading && (
            <div class="terminal-loading-overlay">
              <div class="spinner" />
              <div class="terminal-loading-text">Starting session...</div>
            </div>
          )}
        </div>
        {mobile && activeId && <MobileTerminalToolbar />}
      </div>
    </div>
  );
}

/** Call this from App after creating a session via API to set up the terminal */
export function mountTerminalForSession(sessionId: string, cwd: string, name?: string) {
  // Request notification permission on first terminal creation
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  const container = document.querySelector('.terminal-instances');
  if (!container) return;

  const el = document.createElement('div');
  el.className = 'terminal-instance active';
  el.id = 'term-' + sessionId;

  // Hide all other instances
  container.querySelectorAll('.terminal-instance').forEach(child => {
    child.classList.remove('active');
  });
  container.appendChild(el);

  const instance = createTerminal(sessionId, el);

  // Only add to state if not already present (e.g. from loading placeholder flow)
  if (!sessions.value.find(s => s.id === sessionId)) {
    const sessionName = name || cwd.split('/').pop() || cwd;
    addSession({ id: sessionId, cwd, name: sessionName, createdAt: Date.now() });
  }
  setActiveSessionId(sessionId);

  setTimeout(() => {
    instance.fitAddon.fit();
    attachSession(sessionId);
    wsSend({ type: 'console:resize', sessionId, cols: instance.term.cols, rows: instance.term.rows });
    instance.term.focus();
  }, 100);

  addLocalLog('info', 'Session started: ' + cwd);
}

/** Restore existing sessions from the server (on page refresh).
 *  Only fetches data and adds to state — DOM mounting is handled by ClaudeSection on mount. */
export async function restoreSessions() {
  try {
    const res = await apiFetch('/api/console/sessions');
    const data = await res.json();
    if (data.sessions && data.sessions.length > 0) {
      for (const s of data.sessions) {
        addSession({ id: s.id, type: s.type || 'agent', cwd: s.cwd, name: s.name || s.cwd.split('/').pop() || s.cwd, createdAt: s.createdAt });
      }
      const lastId = data.sessions[data.sessions.length - 1].id;
      setActiveSessionId(lastId);
    }
  } catch { /* ignore */ }
}
