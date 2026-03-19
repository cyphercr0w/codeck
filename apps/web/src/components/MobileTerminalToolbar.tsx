import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { activeSessionId, activeSection } from '../state/store';
import { sendTerminalInput, getTerminalBuffer, scrollToBottom, fitTerminal, repaintTerminal, onTerminalWrite } from '../terminal';

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
  const [adaptiveMode, setAdaptiveMode] = useState<'default' | 'yesno'>('default');
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

  const handleQuickResponse = useCallback((char: string) => {
    send(char + '\r');
    showFeedback(char.toUpperCase());
  }, [send, showFeedback]);

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

  // --- Adaptive prompt detection (event-driven, not polling) ---

  useEffect(() => {
    if (!sessionId) return;
    const YN_PATTERN = /\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]/i;

    // Check on mount for current buffer state
    const lines = getTerminalBuffer(sessionId);
    setAdaptiveMode(YN_PATTERN.test(lines.join('\n')) ? 'yesno' : 'default');

    // Throttle buffer reads: getTerminalBuffer() iterates xterm's line buffer and
    // runs synchronously in the WS onmessage handler. During heavy streaming output,
    // calling it on every newline saturates the main thread and causes input freezes.
    let bufferCheckTimer: ReturnType<typeof setTimeout> | null = null;

    return onTerminalWrite((sid, data) => {
      if (sid !== sessionId) return;
      // Check incoming data chunk first (fast path — no buffer read needed)
      if (YN_PATTERN.test(data)) {
        if (bufferCheckTimer) { clearTimeout(bufferCheckTimer); bufferCheckTimer = null; }
        setAdaptiveMode('yesno');
        return;
      }
      // On newline/enter, re-check buffer — but throttle to avoid main-thread pressure.
      if (data.includes('\r') || data.includes('\n')) {
        if (bufferCheckTimer) return; // already scheduled
        bufferCheckTimer = setTimeout(() => {
          bufferCheckTimer = null;
          const current = getTerminalBuffer(sessionId);
          setAdaptiveMode(YN_PATTERN.test(current.join('\n')) ? 'yesno' : 'default');
        }, 300);
      }
    });
  }, [sessionId]);

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
              {adaptiveMode === 'yesno' ? (
                <>
                  <button class="mobile-shortcut-key yes" {...tap(() => handleQuickResponse('y'))} aria-label="Yes">
                    <span class="mobile-shortcut-label">Y</span>
                    <span class="mobile-shortcut-desc">Yes</span>
                  </button>
                  <button class="mobile-shortcut-key no" {...tap(() => handleQuickResponse('n'))} aria-label="No">
                    <span class="mobile-shortcut-label">N</span>
                    <span class="mobile-shortcut-desc">No</span>
                  </button>
                </>
              ) : (
                SHORTCUTS.map(({ id, seq, label, desc }) => (
                  <button key={id} class="mobile-shortcut-key" {...tap(() => handleShortcut(seq, label))} aria-label={desc}>
                    <span class="mobile-shortcut-label">{label}</span>
                    <span class="mobile-shortcut-desc">{desc}</span>
                  </button>
                ))
              )}
            </div>
          </>
        ) : (
          <button class="mobile-collapsed-bar" {...tap(toggleExpanded)} aria-label="Show special keys">
            <span>Special Keys</span>
            <span class="mobile-collapsed-chevron">▴</span>
          </button>
        )}
      </div>
    </>
  );
}
