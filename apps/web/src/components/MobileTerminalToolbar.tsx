import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { activeSessionId } from '../state/store';
import { sendTerminalInput, getTerminalBuffer, scrollToBottom, fitTerminal, onTerminalWrite } from '../terminal';

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
 */
function tap(fn: () => void) {
  return {
    onPointerUp: (e: PointerEvent) => {
      e.preventDefault();
      const active = document.activeElement as HTMLElement | null;
      if (active?.id === 'mobile-hidden-input') active.blur();
      fn();
    },
  };
}

/** Calculate and set terminal height to fill space between tabs and toolbar. */
function recalcLayout(sessionId: string | undefined) {
  const vh = window.visualViewport?.height ?? window.innerHeight;
  const tabs = document.querySelector('.terminal-tabs');
  const toolbar = document.querySelector('.mobile-toolbar');
  const instances = document.querySelector('.terminal-instances') as HTMLElement | null;
  if (!instances) return;

  const tabsH = tabs?.getBoundingClientRect().height ?? 0;

  // getBoundingClientRect() returns coordinates relative to the visual viewport.
  // When the keyboard is open, the toolbar (position:fixed; bottom:0) may be below
  // the visual viewport on Android (fixed to layout viewport, not visual viewport).
  // On iOS Safari it stays above the keyboard. Only subtract toolbar height if it's
  // actually visible in the current visual viewport.
  const toolbarRect = toolbar?.getBoundingClientRect();
  const toolbarInView = toolbarRect ? toolbarRect.top < vh - 10 : false;
  const toolbarH = toolbarInView ? (toolbarRect?.height ?? 0) : 0;

  const available = Math.max(50, vh - tabsH - toolbarH - 2);

  instances.style.height = `${available}px`;
  instances.style.maxHeight = `${available}px`;

  // Refit xterm to the new size and scroll to bottom
  if (sessionId) {
    requestAnimationFrame(() => {
      fitTerminal(sessionId);
      scrollToBottom(sessionId);
    });
  }
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

  const sessionId = activeSessionId.value;

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
    if (text) send(text);
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
    // Recalc on mount and whenever toolbar expands/collapses
    const timer = setTimeout(() => recalcLayout(sessionId), 50);
    return () => clearTimeout(timer);
  }, [expanded, sessionId]);

  useEffect(() => {
    let settleTimer: ReturnType<typeof setTimeout>;
    const handler = () => {
      // Fire immediately for a responsive feel during keyboard animation,
      // then schedule a final recalc after events settle (keyboard fully open/closed).
      recalcLayout(sessionId);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => recalcLayout(sessionId), 150);
    };
    window.visualViewport?.addEventListener('resize', handler);
    window.addEventListener('resize', handler);
    return () => {
      clearTimeout(settleTimer);
      window.visualViewport?.removeEventListener('resize', handler);
      window.removeEventListener('resize', handler);
    };
  }, [sessionId]);

  // --- Adaptive prompt detection (event-driven, not polling) ---

  useEffect(() => {
    if (!sessionId) return;
    const YN_PATTERN = /\(y\/n\)|\[y\/n\]|\[Y\/n\]|\[y\/N\]/i;

    // Check on mount for current buffer state
    const lines = getTerminalBuffer(sessionId);
    setAdaptiveMode(YN_PATTERN.test(lines.join('\n')) ? 'yesno' : 'default');

    // Subscribe to incoming terminal data for real-time detection
    return onTerminalWrite((sid, data) => {
      if (sid !== sessionId) return;
      // Check incoming data chunk first (fast path)
      if (YN_PATTERN.test(data)) {
        setAdaptiveMode('yesno');
        return;
      }
      // On newline/enter, re-check buffer (prompt may have been answered)
      if (data.includes('\r') || data.includes('\n')) {
        const current = getTerminalBuffer(sessionId);
        setAdaptiveMode(YN_PATTERN.test(current.join('\n')) ? 'yesno' : 'default');
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
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        onFocus={() => {
          resetInput();
          if (sessionId) scrollToBottom(sessionId);
          // Belt-and-suspenders fallback: some Android keyboards take >300ms to fully
          // open. Fire at 300ms, 500ms, and 700ms to catch slow animations.
          setTimeout(() => recalcLayout(sessionId), 300);
          setTimeout(() => recalcLayout(sessionId), 500);
          setTimeout(() => recalcLayout(sessionId), 700);
        }}
        onBlur={() => {
          // Keyboard closing — recalc at multiple points to catch slow animations.
          setTimeout(() => recalcLayout(sessionId), 300);
          setTimeout(() => recalcLayout(sessionId), 500);
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
