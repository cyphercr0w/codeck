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

  // complete() is assigned after unsub is available to break the circular ref
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
    console.debug(`[settle] ${sessionId.slice(0,6)} firing repaint`);
    // fitTerminal first: sends SIGWINCH if canvas was at wrong dims (e.g. 80×24
    // default because a previous fitTerminal bailed on a hidden container).
    // repaintTerminal then calls fitAddon.fit() internally for belt-and-suspenders,
    // does the micro-resize, and scrolls to bottom.
    fitTerminal(sessionId);
    repaintTerminal(sessionId);
    // If the container was still hidden when repaintTerminal ran (it bails on
    // offsetHeight=0), retry once the active class has been applied by the
    // useEffect([activeId]) cycle which runs after sessionList.length effect.
    const el = document.getElementById('term-' + sessionId);
    if (el && el.offsetHeight === 0) {
      console.debug(`[settle] ${sessionId.slice(0,6)} container still 0 — retry in 200ms`);
      setTimeout(() => { fitTerminal(sessionId); repaintTerminal(sessionId); }, 200);
    }
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
    // After WS reconnects and a session is re-attached, resync PTY dimensions,
    // scroll to latest content, and re-focus the active terminal so the user
    // can keep typing without having to click first.
    setOnSessionReattached((sessionId) => {
      // If the terminal doesn't exist yet the page just loaded (F5) and
      // useEffect below will handle mounting.  Only proceed when the terminal
      // is already live (WS transient reconnect).
      if (!getTerminal(sessionId)) return;

      // Fit first, then attach so the server replays at the correct dimensions.
      requestAnimationFrame(() => {
        fitTerminal(sessionId);
        markSessionAttaching(sessionId);
        attachSession(sessionId);
        attachSettleRepaint(sessionId);
        if (sessionId === activeSessionId.value) focusTerminal(sessionId);
      });
    });

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
      el.id = 'term-' + s.id;
      // Set active immediately if this is the active session so fitTerminal
      // sees a non-zero container height. Without this, the element has
      // display:none (no .active class) when the rAF fires → offsetHeight=0
      // → fitTerminal bails → terminal stays at 80×24 default → black screen.
      el.className = s.id === activeId ? 'terminal-instance active' : 'terminal-instance';
      // Hide all other instances so only the new active one is visible.
      if (s.id === activeId) {
        container.querySelectorAll('.terminal-instance').forEach(c => c.classList.remove('active'));
      }
      container.appendChild(el);

      createTerminal(s.id, el);

      // Fit BEFORE attaching so the server replays the PTY buffer at the correct
      // terminal dimensions. If we attach first, replay data renders at xterm's
      // default 80x24 — then fitAddon.fit() reflows to the real size and the
      // viewport ends up in the wrong position (content appears above, black screen).
      const sid = s.id;
      requestAnimationFrame(() => {
        fitTerminal(sid);
        markSessionAttaching(sid);
        attachSession(sid);
        attachSettleRepaint(sid);
      });
    }

  }, [sessionList.length]);

  // After WS reconnect completes (overlay disappears), repaint the active terminal.
  // The reconnect flow may have left the terminal in a stale state (wrong scroll
  // position, wrong dims) especially if it went through the restoring overlay.
  const isRestoring = restoringPending.value;
  const isConnected = wsConnected.value;
  useEffect(() => {
    // Fire when connection is established AND restore overlay has cleared.
    if (!isConnected || isRestoring) return;
    if (!activeId) return;
    // Small delay to let buffer replay and WS attach settle.
    const t = setTimeout(() => {
      fitTerminal(activeId);
      repaintTerminal(activeId);
    }, 800);
    return () => clearTimeout(t);
  }, [isConnected, isRestoring, activeId]);

  // Toggle visible terminal when active tab changes
  useEffect(() => {
    const container = instancesRef.current;
    if (!container || !activeId) return;

    container.querySelectorAll('.terminal-instance').forEach(el => el.classList.remove('active'));
    const activeEl = document.getElementById('term-' + activeId);
    if (activeEl) activeEl.classList.add('active');
    // Use rAF so the browser has applied display:block (CSS active class) and
    // computed the container's layout dimensions before FitAddon measures them.
    // scrollToBottom after fit: xterm may have rendered at wrong dims before
    // this tab was active (80x24 default) — after reflow the viewport can be
    // anywhere, so we always land at the latest content on tab switch.
    // repaintTerminal: force xterm to reposition its viewport after becoming
    // visible. fitAddon.fit() with unchanged dims is a no-op (term.resize not
    // called → syncScrollArea never runs → canvas stays black). The micro-resize
    // trick forces syncScrollArea regardless of whether dimensions changed.
    requestAnimationFrame(() => {
      fitTerminal(activeId);
      requestAnimationFrame(() => repaintTerminal(activeId));
      scrollToBottom(activeId);
      focusTerminal(activeId);
    });
    // Belt-and-suspenders: retry fitTerminal at 100ms and 400ms.
    // On mobile, recalcLayout may not have set .terminal-instances height by
    // the time the first rAF fires (~16ms) — the container still reports 0.
    // fitTerminal deduplicates SIGWINCH (only sends when cols/rows change),
    // so multiple calls are safe — only the first successful one sends resize.
    const id = activeId;
    setTimeout(() => { fitTerminal(id); requestAnimationFrame(() => repaintTerminal(id)); }, 100);
    setTimeout(() => { fitTerminal(id); requestAnimationFrame(() => repaintTerminal(id)); }, 400);
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

  // Clicking the terminal area restores focus to the active terminal.
  // On desktop: focus may be lost after WS reconnects or state updates — clicking
  // should bring it back without the user needing to F5. On mobile: forward to the
  // hidden input that captures keyboard events.
  function handleTerminalTap(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (isMobile.value) {
      if (target.closest('.mobile-toolbar')) return;
      document.getElementById('mobile-hidden-input')?.focus();
    } else {
      // Don't steal focus from tab buttons or close icons
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

  // Attach immediately so the backend starts streaming output, then fit on
  // the next frame once the container has its correct layout dimensions.
  attachSession(sessionId);
  requestAnimationFrame(() => {
    instance.fitAddon.fit();
    wsSend({ type: 'console:resize', sessionId, cols: instance.term.cols, rows: instance.term.rows });
    instance.term.focus();
  });

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
