import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { wsSend } from './ws';
import { isMobile } from './state/store';
import { sanitizeAnsiOutput } from './ansi-sanitizer';

interface TerminalInstance {
  term: Terminal;
  fitAddon: FitAddon;
  resizeObserver: ResizeObserver | null;
  container: HTMLElement;
}

const terminals = new Map<string, TerminalInstance>();

// Mobile scroll lock: when user scrolls up to read history, prevent
// xterm's internal auto-scroll from yanking them back to the bottom.
const scrollLocked = new Map<string, boolean>();

// Terminal write subscribers: components can listen for incoming data
// (e.g., for adaptive prompt detection without polling).
type WriteListener = (sessionId: string, data: string) => void;
const writeListeners = new Set<WriteListener>();

/** Subscribe to terminal write events. Returns unsubscribe function. */
export function onTerminalWrite(listener: WriteListener): () => void {
  writeListeners.add(listener);
  return () => { writeListeners.delete(listener); };
}

export function createTerminal(sessionId: string, container: HTMLElement): TerminalInstance {
  const term = new Terminal({
    theme: { background: '#0a0a0b', foreground: '#fafafa', cursor: '#6366f1' },
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: isMobile.value ? 12 : 14,
    cursorBlink: true,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  // Configure xterm textarea for keyboard handling
  const textarea = container.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
  if (textarea) {
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('spellcheck', 'false');
    textarea.setAttribute('enterkeyhint', 'send');
  }

  // On mobile, disable xterm's textarea so our hidden input takes over.
  if (isMobile.value && textarea) {
    textarea.readOnly = true;
    textarea.tabIndex = -1;
    textarea.style.pointerEvents = 'none';

    // Track recent touch on terminal to distinguish user taps from auto-focus
    let lastTouchTime = 0;
    container.addEventListener('touchstart', () => { lastTouchTime = Date.now(); }, { passive: true });

    textarea.addEventListener('focus', () => {
      textarea.blur();
      if (Date.now() - lastTouchTime < 500) {
        document.getElementById('mobile-hidden-input')?.focus();
      }
    });

    // Disable pointer-events on xterm-screen so touches fall through to
    // xterm-viewport (a real scrollable div with overflow-y). This lets
    // the browser handle native touch scrolling — much smoother than
    // xterm's built-in JS scroll or our custom touchmove handler.
    const screen = container.querySelector('.xterm-screen') as HTMLElement | null;
    if (screen) screen.style.pointerEvents = 'none';

    // NOTE: visualViewport.resize is handled exclusively by MobileTerminalToolbar.
  }

  // Scroll lock — track user scroll intent on ALL platforms.
  // When the user scrolls up into scrollback, lock auto-scroll so they can
  // read history. When they scroll back to the bottom, release the lock.
  // Using the DOM scroll event (not xterm buffer state) as the source of truth:
  // the DOM always reflects where the user's viewport is, regardless of how
  // xterm batches or sequences its internal buffer updates.
  const xtermViewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
  if (xtermViewport) {
    xtermViewport.addEventListener('scroll', () => {
      const atBottom = xtermViewport.scrollTop + xtermViewport.clientHeight >= xtermViewport.scrollHeight - 10;
      scrollLocked.set(sessionId, !atBottom);
    }, { passive: true });
  }

  term.onData((data) => {
    wsSend({ type: 'console:input', sessionId, data });
  });

  // Debounce resize to avoid excessive events on mobile orientation changes.
  // On mobile this is the ONLY place fitAddon.fit() is called — recalcLayout
  // intentionally skips fitTerminal to prevent multiple SIGWINCH signals (which
  // cause brief input freezes while the PTY process redraws).
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        fitAddon.fit();
        wsSend({ type: 'console:resize', sessionId, cols: term.cols, rows: term.rows });
        // After fit, scroll to bottom so content is visible (fit may change row count).
        if (isMobile.value && !scrollLocked.get(sessionId)) {
          term.scrollToBottom();
        }
      }
    }, isMobile.value ? 200 : 50);
  });
  resizeObserver.observe(container);

  const instance: TerminalInstance = { term, fitAddon, resizeObserver, container };
  terminals.set(sessionId, instance);
  return instance;
}

export function getTerminal(sessionId: string): TerminalInstance | undefined {
  return terminals.get(sessionId);
}

export function destroyTerminal(sessionId: string): void {
  const instance = terminals.get(sessionId);
  if (instance) {
    instance.resizeObserver?.disconnect();
    instance.term.dispose();
    terminals.delete(sessionId);
    scrollLocked.delete(sessionId);
  }
}

export function fitTerminal(sessionId: string): void {
  const instance = terminals.get(sessionId);
  if (!instance) return;
  // Don't fit against a hidden container — FitAddon gets 0-size dimensions
  // and would send incorrect cols/rows to the PTY (display:none → offsetWidth=0).
  if (instance.container.offsetWidth === 0 || instance.container.offsetHeight === 0) return;
  const prevCols = instance.term.cols;
  const prevRows = instance.term.rows;
  instance.fitAddon.fit();
  // Only send console:resize if dimensions actually changed — avoids sending
  // SIGWINCH to the running process when the terminal size is already correct.
  // This prevents unnecessary process redraws (and brief input freezes) when
  // fitTerminal is called redundantly on WS reconnect, section switch, etc.
  if (instance.term.cols !== prevCols || instance.term.rows !== prevRows) {
    wsSend({ type: 'console:resize', sessionId, cols: instance.term.cols, rows: instance.term.rows });
  }
}

/**
 * Force xterm to reposition its viewport and repaint after a terminal container
 * becomes visible (e.g. display:none → display:block).
 *
 * Problem: when the terminal was hidden, xterm's cols/rows are already at the
 * correct values from a previous fit. When the container becomes visible and
 * fitAddon.fit() runs, term.resize() receives the same dims → xterm skips the
 * resize → syncScrollArea() never runs → viewport stays at scroll position 0
 * (top of scrollback / blank area) → terminal appears black.
 *
 * Fix: micro-resize (+1 row then back). This forces two calls to syncScrollArea()
 * with different dims, which repositions ydisp to show the cursor (bottom of
 * buffer). Called directly on term — no WS message sent, no SIGWINCH to PTY.
 */
export function repaintTerminal(sessionId: string): void {
  const instance = terminals.get(sessionId);
  if (!instance) return;
  if (instance.container.offsetWidth === 0 || instance.container.offsetHeight === 0) return;
  const { cols, rows } = instance.term;
  instance.term.resize(cols, rows + 1);
  instance.term.resize(cols, rows);
  if (!scrollLocked.get(sessionId)) instance.term.scrollToBottom();
  instance.term.refresh(0, rows - 1);
}

/** Returns the current terminal dimensions, or null if not found / hidden. */
export function getTerminalDimensions(sessionId: string): { cols: number; rows: number } | null {
  const instance = terminals.get(sessionId);
  if (!instance) return null;
  return { cols: instance.term.cols, rows: instance.term.rows };
}

export function writeToTerminal(sessionId: string, data: string): void {
  const instance = terminals.get(sessionId);
  if (!instance) return;

  // Sanitize dangerous ANSI escape sequences (OSC, DCS, PM, APC) before rendering.
  // Allows safe sequences (CSI/SGR for colors, formatting, cursor movement).
  const sanitized = sanitizeAnsiOutput(data);

  // Notify write subscribers (e.g., adaptive prompt detection)
  for (const listener of writeListeners) {
    try { listener(sessionId, sanitized); } catch {}
  }

  // If the user scrolled up to read history, don't yank them to the bottom.
  // scrollLocked is set by the DOM scroll listener in createTerminal — it reflects
  // user intent, not xterm's async buffer state (which can be stale mid-replay).
  if (scrollLocked.get(sessionId)) {
    if (isMobile.value) {
      // Mobile: physically restore the DOM scrollTop after xterm renders, because
      // xterm's internal write can shift the viewport element's scroll position.
      const viewport = instance.term.element?.querySelector('.xterm-viewport') as HTMLElement | null;
      if (viewport) {
        const savedTop = viewport.scrollTop;
        instance.term.write(sanitized, () => { viewport.scrollTop = savedTop; });
        return;
      }
    }
    // Desktop: xterm preserves scroll position natively — just write.
    instance.term.write(sanitized);
    return;
  }

  // Not scroll-locked: write and follow output to the bottom.
  // IMPORTANT: term.write() is async (xterm queues writes internally). Calling
  // scrollToBottom() synchronously after write() doesn't work — the content isn't
  // in the buffer yet, so the viewport stays at the wrong position (black screen).
  // The callback fires after xterm actually processes and renders the data.
  instance.term.write(sanitized, () => {
    // Re-check lock inside the callback: the user may have scrolled up between
    // the write() call and this callback — respect that intent.
    if (!scrollLocked.get(sessionId)) instance.term.scrollToBottom();
  });
}

export function focusTerminal(sessionId: string): void {
  const instance = terminals.get(sessionId);
  if (instance) {
    if (isMobile.value) {
      // On mobile, only re-focus hidden input if keyboard is already open
      // (i.e., hidden input already has focus). Otherwise, don't open keyboard.
      const hiddenInput = document.getElementById('mobile-hidden-input');
      if (document.activeElement === hiddenInput) {
        hiddenInput?.focus();
      }
    } else {
      instance.term.focus();
    }
  }
}

/** Send input data directly to a terminal session via WebSocket */
export function sendTerminalInput(sessionId: string, data: string): void {
  wsSend({ type: 'console:input', sessionId, data });
}

/** Scroll terminal to the very bottom and clear scroll lock */
export function scrollToBottom(sessionId: string): void {
  const instance = terminals.get(sessionId);
  if (instance) {
    scrollLocked.set(sessionId, false);
    instance.term.scrollToBottom();
  }
}

/** Read the last N lines from a terminal's buffer (for prompt detection) */
export function getTerminalBuffer(sessionId: string, lines = 5): string[] {
  const instance = terminals.get(sessionId);
  if (!instance) return [];
  const buffer = instance.term.buffer.active;
  const result: string[] = [];
  const start = Math.max(0, buffer.length - lines);
  for (let i = start; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) result.push(line.translateToString());
  }
  return result;
}
