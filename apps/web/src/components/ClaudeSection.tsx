import { useEffect, useRef, useState } from 'preact/hooks';
import { sessions, activeSessionId, setActiveSessionId, addLocalLog, addSession, removeSession, renameSession, agentName, isMobile, restoringPending, wsConnected } from '../state/store';
import { apiFetch } from '../api';
import { createTerminal, destroyTerminal, fitTerminal, repaintTerminal, focusTerminal, writeToTerminal, scrollToBottom, getTerminal, markSessionAttaching, clearSessionAttaching, onTerminalWrite } from '../terminal';
import { wsSend, setTerminalHandlers, attachSession, setOnSessionReattached } from '../ws';
import { IconPlus, IconX, IconShell, IconTerminal } from './Icons';
import { MobileTerminalToolbar } from './MobileTerminalToolbar';

interface ClaudeSectionProps {
  onNewSession: () => void;
  onNewShell: () => void;
}

/**
 * After markSessionAttaching + attachSession, watch for write events to detect
 * when the buffer replay settles. Once 500ms of silence passes (or 3s max),
 * clear the attach guard and repaint so the terminal shows the cursor position.
 */
function attachSettleRepaint(sessionId: string): void {
  const SETTLE_MS = 500;
  const MAX_WAIT_MS = 3000;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let completed = false;

  let complete: () => void;

  const unsub = onTerminalWrite((sid) => {
    if (sid !== sessionId) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => complete(), SETTLE_MS);
  });

  const maxTimer = setTimeout(() => complete(), MAX_WAIT_MS);

  complete = () => {
    if (completed) return;
    completed = true;
    if (settleTimer) clearTimeout(settleTimer);
    clearTimeout(maxTimer);
    unsub();
    clearSessionAttaching(sessionId);
    fitTerminal(sessionId);
    repaintTerminal(sessionId);

    // Single stabilization retry — safety net for hidden containers or slow layout
    setTimeout(() => {
      if (!getTerminal(sessionId)) return;
      fitTerminal(sessionId);
      repaintTerminal(sessionId);
    }, 500);
  };
}

export function ClaudeSection({ onNewSession, onNewShell }: ClaudeSectionProps) {
  const instancesRef = useRef<HTMLDivElement>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const sessionList = sessions.value;
  const activeId = activeSessionId.value;

  // Register terminal handlers for WS output/exit and post-reconnect resync
  useEffect(() => {
    setOnSessionReattached((sessionId) => {
      if (!getTerminal(sessionId)) return;

      // Call attachSession synchronously to minimize the input buffering window
      markSessionAttaching(sessionId);
      attachSession(sessionId);
      attachSettleRepaint(sessionId);

      requestAnimationFrame(() => {
        fitTerminal(sessionId);
        if (sessionId === activeSessionId.value) focusTerminal(sessionId);
      });
    });

    setTerminalHandlers(
      (sessionId, data) => writeToTerminal(sessionId, data),
      (sessionId) => {
        const session = sessions.value.find(s => s.id === sessionId);
        const cwdShort = session ? session.name : sessionId;

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
      el.id = 'term-' + s.id;
      // Set active class immediately so fitTerminal sees a non-zero container height
      el.className = s.id === activeId ? 'terminal-instance active' : 'terminal-instance';
      if (s.id === activeId) {
        container.querySelectorAll('.terminal-instance').forEach(c => c.classList.remove('active'));
      }
      container.appendChild(el);

      createTerminal(s.id, el);

      const sid = s.id;
      requestAnimationFrame(() => {
        fitTerminal(sid);
        markSessionAttaching(sid);
        attachSession(sid);
        attachSettleRepaint(sid);
      });
    }

  }, [sessionList.length]);

  // Toggle visible terminal when active tab changes
  useEffect(() => {
    const container = instancesRef.current;
    if (!container || !activeId) return;

    container.querySelectorAll('.terminal-instance').forEach(el => el.classList.remove('active'));
    const activeEl = document.getElementById('term-' + activeId);
    if (activeEl) activeEl.classList.add('active');
    requestAnimationFrame(() => {
      fitTerminal(activeId);
      repaintTerminal(activeId);
      scrollToBottom(activeId);
      focusTerminal(activeId);
    });
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
    requestAnimationFrame(() => {
      fitTerminal(id);
      focusTerminal(id);
    });
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

  function handleTerminalTap(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (isMobile.value) {
      if (target.closest('.mobile-toolbar')) return;
      document.getElementById('mobile-hidden-input')?.focus();
    } else {
      if (target.closest('button')) return;
      if (activeId) focusTerminal(activeId);
    }
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
          {sessionList.length === 0 && !restoringPending.value && (
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
          {restoringPending.value && (
            <div class="terminal-loading-overlay">
              <div class="spinner" />
              <div class="terminal-loading-text">Restoring sessions...</div>
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
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  const container = document.querySelector('.terminal-instances');
  if (!container) return;

  const el = document.createElement('div');
  el.className = 'terminal-instance active';
  el.id = 'term-' + sessionId;

  container.querySelectorAll('.terminal-instance').forEach(child => {
    child.classList.remove('active');
  });
  container.appendChild(el);

  const instance = createTerminal(sessionId, el);

  if (!sessions.value.find(s => s.id === sessionId)) {
    const sessionName = name || cwd.split('/').pop() || cwd;
    addSession({ id: sessionId, cwd, name: sessionName, createdAt: Date.now() });
  }
  setActiveSessionId(sessionId);

  attachSession(sessionId);
  requestAnimationFrame(() => {
    instance.fitAddon.fit();
    wsSend({ type: 'console:resize', sessionId, cols: instance.term.cols, rows: instance.term.rows });
    instance.term.focus();
  });

  addLocalLog('info', 'Session started: ' + cwd);
}

/** Restore existing sessions from the server (on page refresh). */
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
