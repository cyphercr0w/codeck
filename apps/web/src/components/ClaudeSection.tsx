import { useEffect, useRef, useState } from 'preact/hooks';
import { sessions, activeSessionId, setActiveSessionId, addLocalLog, addSession, removeSession, renameSession, agentName, isMobile, restoringPending, wsConnected, sessionStatus, setSessionStatus, clearSessionStatus, claudeUsage, contextData } from '../state/store';
import { apiFetch } from '../api';
import { createTerminal, destroyTerminal, fitTerminal, repaintTerminal, focusTerminal, writeToTerminal, scrollToBottom, getTerminal, markSessionAttaching, clearSessionAttaching, onTerminalWrite, ensureTerminalVisible, setOnFilePaste, getTerminalBuffer } from '../terminal';
import { wsSend, setTerminalHandlers, attachSession, setOnSessionReattached, setOnBeforeSessionsRestored, setOnContextLoaded, type ContextLoadedData } from '../ws';
import { IconPlus, IconX, IconShell, IconTerminal } from './Icons';
import { MobileTerminalToolbar } from './MobileTerminalToolbar';
import { UploadOverlay } from './UploadOverlay';

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Extract an image File from a DragEvent, or null if none found. */
function getImageFromDrop(e: DragEvent): File | null {
  const files = e.dataTransfer?.files;
  if (!files) return null;
  for (let i = 0; i < files.length; i++) {
    if (IMAGE_MIME_TYPES.has(files[i].type)) {
      return files[i];
    }
  }
  return null;
}

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
    // Use ensureTerminalVisible instead of direct fit+repaint — it handles
    // the case where the container still has 0x0 dimensions (display:none parent).
    ensureTerminalVisible(sessionId);
  };
}

export function ClaudeSection({ onNewSession, onNewShell }: ClaudeSectionProps) {
  const instancesRef = useRef<HTMLDivElement>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [contextBanner, setContextBanner] = useState<{ sessionId: string; projectName: string; kb: string } | null>(null);
  const [bannerFading, setBannerFading] = useState(false);
  const [showNewSessionMenu, setShowNewSessionMenu] = useState(false);
  const [newTabLoading, setNewTabLoading] = useState(false);
  const [recentConvos, setRecentConvos] = useState<Array<{ id: string; title: string; cwd: string; mtime: number }>>([]);
  const sessionList = sessions.value;
  const activeId = activeSessionId.value;

  // Register terminal handlers for WS output/exit and post-reconnect resync
  useEffect(() => {
    // Clean up stale terminals when sessions are restored after a container restart.
    // Without this, old terminal DOM elements remain in the DOM covering new ones.
    setOnBeforeSessionsRestored(() => {
      const container = instancesRef.current;
      for (const s of sessions.value) {
        destroyTerminal(s.id);
        const el = document.getElementById('term-' + s.id);
        if (el) el.remove();
      }
    });

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

        setSessionStatus(sessionId, 'exited');
        addLocalLog('info', 'Session exited: ' + sessionId);
        destroyTerminal(sessionId);
        const el = document.getElementById('term-' + sessionId);
        if (el) el.remove();
        removeSession(sessionId);
        clearSessionStatus(sessionId);
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
      // Clear new-tab states when real terminal mounts
      if (newTabLoading) setNewTabLoading(false);
      if (showNewSessionMenu) setShowNewSessionMenu(false);

      // Attach session synchronously BEFORE rAF to avoid race condition:
      // WS output can arrive before rAF fires, causing data loss
      const sid = s.id;
      markSessionAttaching(sid);
      attachSession(sid);
      requestAnimationFrame(() => {
        fitTerminal(sid);
        attachSettleRepaint(sid);
      });
    }

    // Safety repaint for the active terminal — catches cases where the initial
    // attach/settle/repaint cycle doesn't paint (e.g., idle session with no buffer
    // replay, or xterm canvas not ready during the first fit cycle).
    // Applies to BOTH mobile and desktop: ResizeObserver can miss the transition
    // from display:none → visible due to dedup logic (same cached dimensions).
    if (activeId && getTerminal(activeId)) {
      const cancel = ensureTerminalVisible(activeId);
      return cancel;
    }
  }, [sessionList.length]);

  // Toggle visible terminal when active tab changes
  useEffect(() => {
    const container = instancesRef.current;
    if (!container) return;

    // Clear all active states first
    container.querySelectorAll('.terminal-instance').forEach(el => el.classList.remove('active'));

    if (!activeId) return; // New Tab — no terminal visible

    const activeEl = document.getElementById('term-' + activeId);
    if (activeEl) activeEl.classList.add('active');
    // Use ensureTerminalVisible instead of bare rAF — handles the case where
    // the container has 0x0 dims (e.g., after session restore while section
    // was hidden). Polls until visible, then fits + repaints.
    const cancel = ensureTerminalVisible(activeId);
    focusTerminal(activeId);
    return cancel;
  }, [activeId]);

  // Fit + repaint active terminal when app returns from background (mobile PWA)
  // or when the tab regains focus. Without this, the terminal shows stale content
  // until the user taps the screen.
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) return;
      const id = activeSessionId.value;
      if (!id || !getTerminal(id)) return;
      // Small delay to let the browser finish layout after resume
      setTimeout(() => {
        fitTerminal(id);
        repaintTerminal(id);
        scrollToBottom(id);
      }, 100);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  // Close new-tab menu when a session is added (e.g. after user picks a project)
  const prevSessionCount = useRef(sessionList.length);
  useEffect(() => {
    if (sessionList.length > prevSessionCount.current) {
      setShowNewSessionMenu(false);
      setNewTabLoading(false);
    }
    prevSessionCount.current = sessionList.length;
  }, [sessionList.length]);

  // Fetch recent conversations when empty state or menu is shown
  useEffect(() => {
    if (sessionList.length === 0 || showNewSessionMenu) {
      apiFetch('/api/console/recent-conversations')
        .then(r => r.json())
        .then(data => { if (data.conversations) setRecentConvos(data.conversations); })
        .catch(() => {});
    }
  }, [sessionList.length, showNewSessionMenu]);

  // Register image paste handler — terminal.ts intercepts Ctrl+V on xterm's
  // textarea, checks the clipboard for images, and calls this callback.
  useEffect(() => {
    setOnFilePaste((file: File) => {
      if (activeSessionId.value) {
        setPendingFile(file);
      }
    });
    return () => setOnFilePaste(null);
  }, []);

  // ── Session status tracking ──
  // Listen for terminal writes to detect active/idle/waiting states.
  // Each write sets status to 'active'; after 5s of silence, transitions to 'idle'.
  // If terminal buffer contains a y/n prompt pattern, status becomes 'waiting'.
  useEffect(() => {
    const YN_PATTERN = /\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]|\? $/i;
    const IDLE_TIMEOUT = 5000;
    const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const unsub = onTerminalWrite((sid, data) => {
      // Clear previous idle timer for this session
      const prev = idleTimers.get(sid);
      if (prev) clearTimeout(prev);

      // Fast path: check incoming chunk for y/n pattern
      if (YN_PATTERN.test(data)) {
        setSessionStatus(sid, 'waiting');
      } else {
        // Check buffer for prompt patterns (handles multi-chunk prompts)
        const lines = getTerminalBuffer(sid, 3);
        const tail = lines.join('\n');
        setSessionStatus(sid, YN_PATTERN.test(tail) ? 'waiting' : 'active');
      }

      // Schedule idle transition
      idleTimers.set(sid, setTimeout(() => {
        idleTimers.delete(sid);
        // Only transition to idle if still active/waiting (not exited)
        const current = sessionStatus.value[sid];
        if (current === 'active' || current === 'waiting') {
          // Re-check buffer — prompt may still be visible
          const lines = getTerminalBuffer(sid, 3);
          const tail = lines.join('\n');
          setSessionStatus(sid, YN_PATTERN.test(tail) ? 'waiting' : 'idle');
        }
      }, IDLE_TIMEOUT));
    });

    return () => {
      unsub();
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
    };
  }, []);

  // Context Loaded banner — shows briefly when memory is injected into a new session
  useEffect(() => {
    let fadeTimer: ReturnType<typeof setTimeout> | null = null;
    let removeTimer: ReturnType<typeof setTimeout> | null = null;

    setOnContextLoaded((sessionId: string, data: ContextLoadedData) => {
      // Clear any existing timers from a previous banner
      if (fadeTimer) clearTimeout(fadeTimer);
      if (removeTimer) clearTimeout(removeTimer);

      const kb = (data.charsInjected / 1024).toFixed(1);
      setContextBanner({ sessionId, projectName: data.projectName, kb });
      setBannerFading(false);

      // Start fade-out after 3s, then remove after animation completes (1s)
      fadeTimer = setTimeout(() => setBannerFading(true), 3000);
      removeTimer = setTimeout(() => {
        setContextBanner(null);
        setBannerFading(false);
      }, 4000);
    });

    return () => {
      if (fadeTimer) clearTimeout(fadeTimer);
      if (removeTimer) clearTimeout(removeTimer);
      setOnContextLoaded(() => {});
    };
  }, []);

  // Drag & drop image detection
  function handleDragOver(e: DragEvent) {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      setDragOver(true);
    }
  }

  function handleDragLeave(e: DragEvent) {
    // Only clear when leaving the container (not entering a child)
    const related = e.relatedTarget as HTMLElement | null;
    if (!related || !instancesRef.current?.contains(related)) {
      setDragOver(false);
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const img = getImageFromDrop(e);
    if (img && activeSessionId.value) {
      setPendingFile(img);
    }
  }

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

  async function resumeConversation(convId: string, cwd: string) {
    if (newTabLoading) return; // prevent double-click
    setNewTabLoading(true);
    try {
      const res = await apiFetch('/api/console/resume', {
        method: 'POST',
        body: JSON.stringify({ conversationId: convId, cwd }),
      });
      const data = await res.json();
      if (data.sessionId) {
        addSession({ id: data.sessionId, type: 'agent', cwd: data.cwd, name: data.name || cwd.split('/').pop() || 'session', createdAt: Date.now(), conversationId: convId });
        setActiveSessionId(data.sessionId);
      }
    } catch { /* non-fatal */ }
    setNewTabLoading(false);
    setShowNewSessionMenu(false);
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
    clearSessionStatus(id);
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
    // Notify server this client is now active — triggers PTY resize to
    // match this client's dimensions. Critical for mobile/desktop coexistence.
    if (activeId) {
      wsSend({ type: 'console:focus', sessionId: activeId });
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
                class={`terminal-tab${s.id === activeId ? ' active' : ''}${s.loading ? ' is-loading' : ''}${s.type === 'shell' ? ' shell' : ''}`}
                onClick={() => !s.loading && switchToSession(s.id)}
                title={s.cwd}
              >
                {s.loading ? (
                  <span class="terminal-tab-loading">
                    <span class="spinner-sm" />
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
                    <span class={`tab-status-dot ${sessionStatus.value[s.id] || 'idle'}`} />
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
          {(showNewSessionMenu || newTabLoading) && (
            <button
              class={`terminal-tab${!activeId || newTabLoading ? ' active' : ''}`}
              onClick={() => { if (!newTabLoading) setActiveSessionId(null); }}
            >
              {newTabLoading ? (
                <>
                  <span class="spinner-sm" style={{ flexShrink: 0 }} />
                  <span>Loading</span>
                </>
              ) : (
                <span>New Tab</span>
              )}
              {!newTabLoading && (
                <button
                  class="terminal-tab-close"
                  aria-label="Cancel new session"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowNewSessionMenu(false);
                    const id = sessionList.length > 0 ? sessionList[sessionList.length - 1].id : null;
                    if (id) {
                      setActiveSessionId(id);
                      requestAnimationFrame(() => { fitTerminal(id); focusTerminal(id); });
                    }
                  }}
                >
                  <IconX size={12} />
                </button>
              )}
            </button>
          )}
          {!showNewSessionMenu && !newTabLoading && (
            <button
              class="terminal-tab-new"
              aria-label="New Session"
              disabled={sessionList.length >= 5}
              onClick={() => { setShowNewSessionMenu(true); setActiveSessionId(null); }}
            >
              <IconPlus size={14} />
            </button>
          )}
        </div>
        <div
          class={`terminal-instances${dragOver ? ' drag-over' : ''}`}
          ref={instancesRef}
          onClick={handleTerminalTap}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {contextBanner && (
            <div class={`context-loaded-banner${bannerFading ? ' fade-out' : ''}`}>
              Context loaded: {contextBanner.projectName} &middot; {contextBanner.kb} KB of memory injected
            </div>
          )}
          {(sessionList.length === 0 || (showNewSessionMenu && !activeId) || newTabLoading) && !restoringPending.value && (
            <div
              class="claude-empty"
              onClick={(e) => {
                if (e.target === e.currentTarget) {
                  // noop — don't dismiss, user can click X on the tab
                }
              }}
            >
              {newTabLoading ? (
                <>
                  <div class="spinner-lg" />
                  <div class="claude-empty-title">Loading session...</div>
                </>
              ) : (
                <>
                  <div class="claude-empty-icon"><IconTerminal size={48} /></div>
                  <div class="claude-empty-title">{sessionList.length === 0 ? 'Ready when you are' : 'New session'}</div>
                  <div class="claude-empty-desc">
                    {sessionList.length === 0
                      ? 'Start a new session to begin coding with Claude.'
                      : 'Choose session type:'}
                  </div>
                  <div class="claude-empty-actions">
                    <button class="claude-empty-btn primary" onClick={() => onNewSession()}>New Agent</button>
                    <button class="claude-empty-btn secondary" onClick={() => onNewShell()}>New Shell</button>
                  </div>
                </>
              )}
              {recentConvos.length > 0 && !newTabLoading && (
                <div class="claude-recent-convos">
                  <div class="claude-recent-title">Recent conversations</div>
                  {recentConvos.map(c => {
                    // Check if this conversation is already open by matching conversationId
                    const openSession = sessionList.find(s => s.conversationId === c.id);
                    return (
                      <button
                        key={c.id}
                        class={`claude-recent-item${openSession ? ' open' : ''}`}
                        onClick={() => {
                          if (openSession) {
                            // Switch to the existing tab
                            switchToSession(openSession.id);
                          } else {
                            resumeConversation(c.id, c.cwd);
                          }
                        }}
                      >
                        <span class="claude-recent-text">
                          <span class="claude-recent-project">{c.cwd.split('/').pop() || 'workspace'}</span>
                          <span class="claude-recent-date">{new Date(c.mtime).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                        </span>
                        <span class="claude-recent-meta">
                          {openSession && <span class="claude-recent-open-badge">OPEN</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
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
        {dragOver && (
          <div class="image-drop-indicator">
            <div class="image-drop-indicator-text">Drop image here</div>
          </div>
        )}
      </div>
      <UploadOverlay file={pendingFile} onDone={() => setPendingFile(null)} />
      {activeId && !mobile && <TerminalStatusBar />}
    </div>
  );
}

function TerminalStatusBar() {
  const usage = claudeUsage.value;
  const ctx = contextData.value;
  const status = sessionStatus.value[activeSessionId.value || ''] || 'idle';
  const activeSession = sessions.value.find(s => s.id === activeSessionId.value);
  const uptime = activeSession ? Math.floor((Date.now() - activeSession.createdAt) / 60000) : 0;

  function formatUptime(mins: number): string {
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}m`;
  }

  function formatReset(iso: string | null): string {
    if (!iso) return '';
    const diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return 'now';
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (h >= 24) return `${Math.floor(h / 24)}d`;
    if (h > 0) return `${h}h${m}m`;
    return `${m}m`;
  }

  function barColor(p: number): string {
    if (p < 60) return 'var(--accent)';
    if (p < 85) return 'var(--warning)';
    return 'var(--error)';
  }

  return (
    <div class="terminal-status-bar">
      <div class="tsb-left">
        {ctx && ctx.contextPercent > 0 && (
          <>
            <div class="tsb-limit">
              <span class="tsb-limit-label">CTX</span>
              <div class="tsb-limit-bar">
                <div class="tsb-limit-fill" style={{ width: `${Math.min(100, ctx.contextPercent)}%`, background: barColor(ctx.contextPercent) }} />
              </div>
              <span class="tsb-limit-pct">{ctx.contextPercent}%</span>
            </div>
            <span class="tsb-sep">|</span>
          </>
        )}
        {usage?.available && (
          <>
            {usage.fiveHour && (
              <div class="tsb-limit-group">
                <div class="tsb-limit">
                  <span class="tsb-limit-label">5h</span>
                  <div class="tsb-limit-bar">
                    <div class="tsb-limit-fill" style={{ width: `${Math.min(100, usage.fiveHour.percent)}%`, background: barColor(usage.fiveHour.percent) }} />
                  </div>
                  <span class="tsb-limit-pct">{usage.fiveHour.percent}%</span>
                </div>
                {usage.fiveHour.resetsAt && <span class="tsb-limit-reset">resets {formatReset(usage.fiveHour.resetsAt)}</span>}
              </div>
            )}
            {usage.fiveHour && usage.sevenDay && <span class="tsb-sep">|</span>}
            {usage.sevenDay && (
              <div class="tsb-limit-group">
                <div class="tsb-limit">
                  <span class="tsb-limit-label">7d</span>
                  <div class="tsb-limit-bar">
                    <div class="tsb-limit-fill" style={{ width: `${Math.min(100, usage.sevenDay.percent)}%`, background: barColor(usage.sevenDay.percent) }} />
                  </div>
                  <span class="tsb-limit-pct">{usage.sevenDay.percent}%</span>
                </div>
                {usage.sevenDay.resetsAt && <span class="tsb-limit-reset">resets {formatReset(usage.sevenDay.resetsAt)}</span>}
              </div>
            )}
          </>
        )}
      </div>
      <div class="tsb-right">
        <span class={`tsb-dot tsb-dot-${status}`} />
        <span class="tsb-label">{status === 'waiting' ? 'Waiting' : status}</span>
        <span class="tsb-sep">|</span>
        <span class="tsb-uptime">Session: {formatUptime(uptime)}</span>
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
  // Use ensureTerminalVisible instead of a single rAF — on mobile the container
  // may not have final dimensions yet (header hiding, toolbar appearing, layout shift).
  ensureTerminalVisible(sessionId);
  requestAnimationFrame(() => {
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
