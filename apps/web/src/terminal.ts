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

// Sessions currently in the attach/replay phase. During buffer replay, xterm
// updates scrollHeight before scrollTop, causing the scroll listener to set
// scrollLocked=true spuriously. Suppressing the lock during replay prevents
// the "black terminal" race where every write restores the wrong (0) scrollTop.
const attachingSession = new Set<string>();

/** Call before attachSession to suppress spurious scroll lock during replay. */
export function markSessionAttaching(sessionId: string): void {
  attachingSession.add(sessionId);
}

/** Call after replay settles to re-enable scroll lock detection and repaint. */
export function clearSessionAttaching(sessionId: string): void {
  attachingSession.delete(sessionId);
}

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
      // During attach/replay, xterm updates scrollHeight before scrollTop — the
      // brief desync makes atBottom appear false even though we're at the bottom.
      // Suppress scroll lock updates during this window to avoid locking on a
      // stale position and causing all subsequent writes to restore the wrong scrollTop.
      if (attachingSession.has(sessionId)) return;
      const atBottom = xtermViewport.scrollTop + xtermViewport.clientHeight >= xtermViewport.scrollHeight - 10;
      scrollLocked.set(sessionId, !atBottom);
    }, { passive: true });
  }

  term.onData((data) => {
    wsSend({ type: 'console:input', sessionId, data });
  });

  // Debounce resize to avoid excessive events on mobile orientation changes.
  // Deduplicates SIGWINCH: only sends console:resize when cols/rows actually change,
  // matching the same guard in fitTerminal(). This makes it safe to call fitTerminal
  // explicitly from recalcLayout as a fallback without risking double SIGWINCH.
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const resizeObserver = new ResizeObserver(() => {
    console.debug(`[ResizeObserver] ${sessionId.slice(0,6)} container=${container.offsetWidth}x${container.offsetHeight}`);
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        const prevCols = term.cols;
        const prevRows = term.rows;
        fitAddon.fit();
        if (term.cols !== prevCols || term.rows !== prevRows) {
          console.debug(`[ResizeObserver] RESIZE ${prevCols}x${prevRows} → ${term.cols}x${term.rows}`);
          wsSend({ type: 'console:resize', sessionId, cols: term.cols, rows: term.rows });
        }
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
  const cw = instance.container.offsetWidth, ch = instance.container.offsetHeight;
  console.debug(`[fit] ${sessionId.slice(0,6)} container=${cw}x${ch} term=${instance.term.cols}x${instance.term.rows}`);
  if (cw === 0 || ch === 0) { console.debug(`[fit] BAIL zero dims`); return; }
  const prevCols = instance.term.cols;
  const prevRows = instance.term.rows;
  instance.fitAddon.fit();
  // Only send console:resize if dimensions actually changed — avoids sending
  // SIGWINCH to the running process when the terminal size is already correct.
  // This prevents unnecessary process redraws (and brief input freezes) when
  // fitTerminal is called redundantly on WS reconnect, section switch, etc.
  if (instance.term.cols !== prevCols || instance.term.rows !== prevRows) {
    console.debug(`[fit] RESIZE ${prevCols}x${prevRows} → ${instance.term.cols}x${instance.term.rows}`);
    wsSend({ type: 'console:resize', sessionId, cols: instance.term.cols, rows: instance.term.rows });
  } else {
    console.debug(`[fit] same dims ${instance.term.cols}x${instance.term.rows} — no resize sent`);
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
  const cw2 = instance.container.offsetWidth, ch2 = instance.container.offsetHeight;
  console.debug(`[repaint] ${sessionId.slice(0,6)} container=${cw2}x${ch2} term=${instance.term.cols}x${instance.term.rows} scrollLocked=${scrollLocked.get(sessionId)}`);
  if (cw2 === 0 || ch2 === 0) { console.debug(`[repaint] BAIL zero dims`); return; }
  // Ensure terminal canvas matches the current container size before micro-resizing.
  // If fitTerminal previously bailed (container was hidden → 0 height), the canvas
  // might be at xterm's default 80×24 even though the container is now 600px tall.
  // fitAddon.fit() recalculates correct cols/rows from the container and resizes
  // internally. This does NOT send SIGWINCH — callers should call fitTerminal()
  // first if they also need the server/PTY to know the new dimensions.
  instance.fitAddon.fit();
  const { cols, rows } = instance.term;
  instance.term.resize(cols, rows + 1);
  instance.term.resize(cols, rows);
  // repaintTerminal is called explicitly to bring the terminal into view —
  // always scroll to bottom regardless of scroll lock. The scroll lock reflects
  // user intent during normal reading, but repaint is triggered by system events
  // (tab switch, reconnect, keyboard open) where we MUST show the cursor position.
  // Also clear the scroll lock so subsequent writes follow output correctly.
  scrollLocked.set(sessionId, false);
  instance.term.scrollToBottom();
  // Direct DOM scroll as backup — term.scrollToBottom() updates xterm's virtual
  // ydisp but the DOM .xterm-viewport scrollTop can lag or be stale.
  const viewport = instance.container.querySelector('.xterm-viewport') as HTMLElement | null;
  if (viewport) viewport.scrollTop = viewport.scrollHeight;
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
  // Exception: during attach/replay (attachingSession), always follow output — the
  // scroll lock was suppressed during replay, but clear it here as belt-and-suspenders.
  if (scrollLocked.get(sessionId) && !attachingSession.has(sessionId)) {
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
