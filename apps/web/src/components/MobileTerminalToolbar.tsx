import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { activeSessionId, activeSection, mobileKeyboardOpen, claudeUsage, contextData, sessionStatus, sessions } from '../state/store';
import { sendTerminalInput, scrollToBottom, fitTerminal, repaintTerminal } from '../terminal';

// Escape sequences for special keys
const SPECIAL_KEYS: Record<string, string> = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Enter: '\r',
  Tab: '\t',
  Escape: '\x1b',
  Backspace: '\x7f',
  Delete: '\x1b[3~',
};

// Direct shortcuts — no modifier combos, just tap and send
const SHORTCUTS = [
  { id: 'ctrl-c', seq: '\x03', label: '^C', desc: 'Cancel' },
  { id: 'ctrl-u', seq: '\x15', label: '^U', desc: 'Kill line' },
  { id: 'ctrl-d', seq: '\x04', label: '^D', desc: 'EOF' },
  { id: 'ctrl-l', seq: '\x0c', label: '^L', desc: 'Clear' },
  { id: 'ctrl-a', seq: '\x01', label: '^A', desc: 'Home' },
  { id: 'ctrl-e', seq: '\x05', label: '^E', desc: 'End' },
  { id: 'ctrl-r', seq: '\x12', label: '^R', desc: 'Search' },
  { id: 'ctrl-w', seq: '\x17', label: '^W', desc: 'Del word' },
  { id: 'paste', seq: 'CLIPBOARD_PASTE', label: '^V', desc: 'Paste' },
] as const;

// Sentinel character kept in hidden input so backspace always fires an event.
// Without this, pressing backspace on an empty input does nothing on mobile.
const SENTINEL = '\u200B'; // Zero-width space

/**
 * Unified tap handler using Pointer Events. Handles mouse, touch, and stylus
 * in a single code path. preventDefault stops the browser from opening the
 * keyboard or firing redundant events.
 *
 * IMPORTANT: do NOT blur mobile-hidden-input here. Any blur without an
 * immediate re-focus disconnects keyboard events — the user can see the
 * keyboard but keystrokes reach no handler (freeze). Re-focus after fn()
 * to keep the hidden input connected even after toolbar button taps.
 */
function tap(fn: () => void) {
  return {
    onPointerUp: (e: PointerEvent) => {
      e.preventDefault();
      fn();
      // Re-focus hidden input so keyboard events keep flowing after toolbar tap.
      // Without this, the input stays blurred and the user must tap the terminal
      // area to recover — which looks like an input freeze.
      const input = document.getElementById('mobile-hidden-input') as HTMLInputElement | null;
      input?.focus();
    },
  };
}

/**
 * With interactive-widget=resizes-content and the toolbar in normal flex flow,
 * CSS handles all layout automatically. This helper only exists for cases where
 * we need to explicitly re-fit the terminal (section switch, mount).
 * ResizeObserver handles keyboard open/close fits automatically.
 */
function manualFit(sessionId: string | undefined) {
  if (!sessionId) return;
  const tabs = document.querySelector('.terminal-tabs');
  if (!tabs || tabs.getBoundingClientRect().height === 0) return; // section hidden
  fitTerminal(sessionId);
}

export function MobileTerminalToolbar() {
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem('codeck-mobile-keys') !== 'hidden'; }
    catch { return true; }
  });
  const [feedback, setFeedback] = useState<string | null>(null);
  const adaptiveMode = 'default'; // Y/N adaptive mode removed
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout>>();

  const sessionId = activeSessionId.value ?? undefined;

  // --- Sentinel management ---

  const resetInput = useCallback(() => {
    const el = hiddenInputRef.current;
    if (el) {
      el.value = SENTINEL;
      el.setSelectionRange(1, 1);
    }
  }, []);

  // --- Core helpers ---

  const send = useCallback((data: string) => {
    if (sessionId) {
      sendTerminalInput(sessionId, data);
      scrollToBottom(sessionId);
    }
  }, [sessionId]);

  const showFeedback = useCallback((text: string) => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    setFeedback(text);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 800);
  }, []);

  // --- Toggle show/hide (persisted) ---

  const toggleExpanded = useCallback(() => {
    setExpanded(prev => {
      const next = !prev;
      try { localStorage.setItem('codeck-mobile-keys', next ? 'visible' : 'hidden'); } catch {}
      return next;
    });
  }, []);

  // --- Hidden input handlers ---

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (e.key in SPECIAL_KEYS) {
      e.preventDefault();
      send(SPECIAL_KEYS[e.key]);
      resetInput();
      return;
    }
  }, [send, resetInput]);

  // Debounce guard: some mobile keyboards fire multiple input events for a
  // single keystroke when switching to numbers/symbols layout. Track last
  // sent text + timestamp to suppress duplicates within 50ms.
  const lastSent = useRef<{ text: string; time: number }>({ text: '', time: 0 });

  const handleInput = useCallback((e: Event) => {
    const target = e.target as HTMLInputElement;
    const inputEvent = e as InputEvent;
    if (inputEvent.inputType === 'deleteContentBackward') {
      send('\x7f');
      resetInput();
      return;
    }
    // Extract only new text (after sentinel)
    const raw = target.value;
    const text = raw.startsWith(SENTINEL) ? raw.slice(SENTINEL.length) : raw;
    if (text) {
      const now = Date.now();
      // Suppress duplicate if same text within 50ms (keyboard double-fire)
      if (text === lastSent.current.text && now - lastSent.current.time < 50) {
        resetInput();
        return;
      }
      lastSent.current = { text, time: now };
      send(text);
    }
    resetInput();
  }, [send, resetInput]);

  // --- Button handlers ---

  const handleNavKey = useCallback((key: string) => {
    if (key in SPECIAL_KEYS) send(SPECIAL_KEYS[key]);
  }, [send]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        send(text);
        showFeedback('Pasted');
      }
    } catch {
      hiddenInputRef.current?.focus();
      showFeedback('Long-press to paste');
    }
  }, [send, showFeedback]);

  const handleShortcut = useCallback((seq: string, label: string) => {
    if (seq === 'CLIPBOARD_PASTE') {
      handlePaste();
      return;
    }
    send(seq);
    showFeedback(label);
  }, [send, showFeedback, handlePaste]);

  // --- Layout: calculate terminal height to fill space above fixed toolbar ---

  useEffect(() => {
    // Fit after toolbar expand/collapse changes the available terminal space.
    // Short delay lets the CSS transition settle before measuring.
    const timer = setTimeout(() => manualFit(sessionId), 100);
    return () => clearTimeout(timer);
  }, [expanded, sessionId]);

  // No visualViewport listener needed — ResizeObserver on the terminal container
  // handles fits when the viewport resizes (keyboard open/close, orientation).

  // --- Recalc when section switches to 'claude' ---
  // When the user navigates to the Claude section, .terminal-tabs becomes visible
  // and getBoundingClientRect() returns its real height. Recalc so the terminal
  // gets its correct explicit height and fitTerminal sends the right SIGWINCH.
  // Also call repaintTerminal to ensure scroll position is correct (without it,
  // the terminal may show ydisp=0 / top of scrollback instead of the current output).
  const currentSection = activeSection.value;
  useEffect(() => {
    if (currentSection === 'claude') {
      // After switching to terminal section, fit and repaint
      const t = setTimeout(() => {
        manualFit(sessionId);
        if (sessionId) repaintTerminal(sessionId);
      }, 100);
      return () => clearTimeout(t);
    }
  }, [currentSection, sessionId]);


  return (
    <>
      {/* Offscreen hidden input — captures native keyboard */}
      <input
        ref={hiddenInputRef}
        id="mobile-hidden-input"
        type="text"
        class="mobile-hidden-input"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck={false}
        enterkeyhint="send"
        aria-label="Terminal keyboard input"
        role="textbox"
        data-form-type="other"
        data-lpignore="true"
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        onFocus={() => {
          resetInput();
          if (sessionId) scrollToBottom(sessionId);
        }}
        onBlur={() => {
          // Keyboard closing — scroll to bottom after animation settles.
          setTimeout(() => { if (sessionId) scrollToBottom(sessionId); }, 400);
        }}
      />

      {/* Visual feedback popup */}
      {feedback && (
        <div class="mobile-key-feedback" key={feedback + Date.now()}>
          {feedback}
        </div>
      )}

      {/* Fixed toolbar */}
      <div class={`mobile-toolbar${expanded ? '' : ' collapsed'}`} role="toolbar" aria-label="Terminal controls">
        {expanded ? (
          <>
            {/* Row 1: Navigation + collapse toggle */}
            <div class="mobile-toolbar-row">
              {([
                ['ArrowUp', '↑'],
                ['ArrowDown', '↓'],
                ['ArrowLeft', '←'],
                ['ArrowRight', '→'],
              ] as const).map(([key, symbol]) => (
                <button key={key} class="mobile-nav-key" {...tap(() => handleNavKey(key))} aria-label={key}>
                  {symbol}
                </button>
              ))}
              <button class="mobile-nav-key primary" {...tap(() => handleNavKey('Enter'))} aria-label="Enter">
                ↵
              </button>
              <button class="mobile-nav-key" {...tap(() => handleNavKey('Tab'))} aria-label="Tab">
                ⇥
              </button>
              <button class="mobile-nav-key esc" {...tap(() => handleNavKey('Escape'))} aria-label="Escape">
                ESC
              </button>
              <button class="mobile-toggle-btn" {...tap(toggleExpanded)} aria-label="Hide keys">
                ▾
              </button>
            </div>

            {/* Row 2: Shortcuts (or adaptive Y/N) */}
            <div class="mobile-toolbar-row">
              {SHORTCUTS.map(({ id, seq, label, desc }) => (
                <button key={id} class="mobile-shortcut-key" {...tap(() => handleShortcut(seq, label))} aria-label={desc}>
                  <span class="mobile-shortcut-label">{label}</span>
                  <span class="mobile-shortcut-desc">{desc}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <button class="mobile-collapsed-bar" {...tap(toggleExpanded)} aria-label="Show special keys">
            <span>Special Keys</span>
            <span class="mobile-collapsed-chevron">▴</span>
          </button>
        )}
      </div>

      {/* Usage limits bar — shown below special keys when keyboard is closed */}
      {!mobileKeyboardOpen.value && <MobileLimitsBar />}
    </>
  );
}

// ── Mobile Limits Bar ──
// Compact version of the desktop TerminalStatusBar showing CTX, 5h, 7d limits.

function barColor(p: number): string {
  if (p < 60) return 'var(--accent)';
  if (p < 85) return 'var(--warning)';
  return 'var(--error)';
}

function MobileLimitsBar() {
  const usage = claudeUsage.value;
  const rawCtx = contextData.value;
  const ctx = rawCtx && (Date.now() - rawCtx.updatedAt < 30_000) ? rawCtx : null;
  const sid = activeSessionId.value || '';
  const status = sessionStatus.value[sid] || 'idle';
  const activeSession = sessions.value.find(s => s.id === sid);
  const uptime = activeSession ? Math.floor((Date.now() - activeSession.createdAt) / 60000) : 0;

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

  function formatUptime(mins: number): string {
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  const hasLimits = (ctx && ctx.contextPercent > 0) || usage?.available;
  if (!hasLimits) return null;

  return (
    <div class="mobile-limits-bar">
      <div class="mobile-limits-items">
        {ctx && ctx.contextPercent > 0 && (
          <div class="mobile-limits-item">
            <span class="mobile-limits-label">CTX</span>
            <div class="ctx-segments">
              {[0, 1, 2, 3, 4].map(i => {
                const segStart = i * 20;
                const pct = ctx.contextPercent;
                const filled = pct >= segStart + 20;
                const partial = !filled && pct > segStart;
                return (
                  <div
                    key={i}
                    class={`ctx-seg${filled ? ' filled' : ''}${partial ? ' partial' : ''}`}
                    style={filled ? { background: barColor(pct) } : partial ? { background: `linear-gradient(to right, ${barColor(pct)} ${((pct - segStart) / 20) * 100}%, var(--bg-tertiary, #333) ${((pct - segStart) / 20) * 100}%)` } : undefined}
                  />
                );
              })}
            </div>
            <span class="mobile-limits-pct">{ctx.contextPercent}%</span>
          </div>
        )}
        {ctx && ctx.contextPercent > 0 && usage?.available && <span class="mobile-limits-sep">|</span>}
        {usage?.available && usage.fiveHour && (
          <div class="mobile-limits-item">
            <span class="mobile-limits-label">5h</span>
            <div class="mobile-limits-bar-track">
              <div class="mobile-limits-bar-fill" style={{ width: `${Math.min(100, usage.fiveHour.percent)}%`, background: barColor(usage.fiveHour.percent) }} />
            </div>
            <span class="mobile-limits-pct">{usage.fiveHour.percent}%</span>
            {usage.fiveHour.resetsAt && <span class="mobile-limits-reset">{formatReset(usage.fiveHour.resetsAt)}</span>}
          </div>
        )}
        {usage?.available && usage.fiveHour && usage.sevenDay && <span class="mobile-limits-sep">|</span>}
        {usage?.available && usage.sevenDay && (
          <div class="mobile-limits-item">
            <span class="mobile-limits-label">7d</span>
            <div class="mobile-limits-bar-track">
              <div class="mobile-limits-bar-fill" style={{ width: `${Math.min(100, usage.sevenDay.percent)}%`, background: barColor(usage.sevenDay.percent) }} />
            </div>
            <span class="mobile-limits-pct">{usage.sevenDay.percent}%</span>
            {usage.sevenDay.resetsAt && <span class="mobile-limits-reset">{formatReset(usage.sevenDay.resetsAt)}</span>}
          </div>
        )}
      </div>
      <div class="mobile-limits-status">
        <span class={`tsb-dot tsb-dot-${status}`} />
        <span class="mobile-limits-status-text">{status === 'waiting' ? 'Waiting' : status}</span>
        {ctx?.model && <span class="mobile-limits-model">{ctx.model}</span>}
      </div>
    </div>
  );
}
