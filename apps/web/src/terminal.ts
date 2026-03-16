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
  textarea: HTMLTextAreaElement | null;
}

const terminals = new Map<string, TerminalInstance>();

// Image paste callback — set by ClaudeSection to handle image uploads.
// When set, Ctrl+V in xterm checks the clipboard for images first.
let onImagePaste: ((file: File) => void) | null = null;

/** Register a callback for image paste events from the terminal. */
export function setOnImagePaste(handler: ((file: File) => void) | null): void {
  onImagePaste = handler;
}

// Mobile scroll lock: when user scrolls up to read history, prevent
// xterm's internal auto-scroll from yanking them back to the bottom.
const scrollLocked = new Map<string, boolean>();

// Sessions currently in the attach/replay phase. During buffer replay, xterm
// updates scrollHeight before scrollTop, causing the scroll listener to set
// scrollLocked=true spuriously. Suppressing the lock during replay prevents
// the "black terminal" race where every write restores the wrong (0) scrollTop.
const attachingSession = new Set<string>();

// Deadline timestamps (ms since epoch) per session for suppressing scroll events
// triggered by our OWN programmatic scrollToBottom() calls. Without this, the
// scroll event fired by scrollToBottom() in a write callback can race with a
// concurrent buffer expansion (scrollHeight grows) and make atBottom=false →
// spuriously set scrollLocked=true even though the user never scrolled up.
const programmaticScrollUntil = new Map<string, number>();

/** Mark the next ~100ms of scroll events as programmatic for this session. */
function suppressScrollEvents(sessionId: string): void {
  programmaticScrollUntil.set(sessionId, Date.now() + 100);
}

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

  // Prevent xterm from handling Ctrl+V / Cmd+V at the keyboard level.
  // By returning false, xterm doesn't send ^V (0x16) to the PTY.
  // Instead, the browser's default Ctrl+V behavior fires a paste event
  // on the textarea, which our paste listener below handles:
  //   - If clipboard has an image → show upload overlay
  //   - If clipboard has text → xterm's own paste handler inserts it
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'v' && e.type === 'keydown') {
      return false; // let browser handle → triggers paste event
    }
    return true; // let xterm handle all other keys
  });

  // Configure xterm textarea for keyboard handling
  const textarea = container.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
  if (textarea) {
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('spellcheck', 'false');
    textarea.setAttribute('enterkeyhint', 'send');

    // Intercept paste events on xterm's textarea to detect clipboard images.
    // Uses capture phase to fire BEFORE xterm's own paste handler.
    // The paste event has synchronous access to clipboardData (no permissions needed).
    // If the clipboard contains an image, we block xterm from pasting and show
    // the upload overlay. If it's text-only, we let the event propagate normally.
    textarea.addEventListener('paste', (e: ClipboardEvent) => {
      if (!onImagePaste) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) {
            e.preventDefault();
            e.stopImmediatePropagation();
            onImagePaste(file);
            return;
          }
        }
      }
      // No image found — let xterm handle the text paste normally
    }, true); // capture phase

    // Log blur events to DevTools — useful for diagnosing input freezes locally
    // without any network overhead (no WS message sent).
    textarea.addEventListener('blur', () => {
      const active = document.activeElement;
      const activeInfo = `${active?.tagName}#${(active as HTMLElement)?.id || ''}.${(active as HTMLElement)?.className?.toString().split(' ').slice(0,2).join('.')}`;
      console.warn(`[xterm] ${sessionId.slice(0,6)} textarea BLUR — input will freeze until re-focused. activeElement=${activeInfo}`);
    });
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
      if (attachingSession.has(sessionId)) return;
      // Ignore scroll events triggered by our own programmatic scrollToBottom()
      const deadline = programmaticScrollUntil.get(sessionId) ?? 0;
      if (Date.now() < deadline) return;
      const atBottom = xtermViewport.scrollTop + xtermViewport.clientHeight >= xtermViewport.scrollHeight - 10;
      scrollLocked.set(sessionId, !atBottom);
    }, { passive: true });
  }

  term.onData((data) => {
    wsSend({ type: 'console:input', sessionId, data });
  });

  // Debounce resize to avoid excessive events on orientation changes / keyboard.
  // Single resize path for both mobile and desktop: ResizeObserver → fit → send.
  // After fit, scrollToBottom runs synchronously in the same JS task so the browser
  // paints both changes in one frame (no scroll flash).
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastContainerWidth = -1;
  let lastContainerHeight = -1;
  const resizeObserver = new ResizeObserver((entries) => {
    // Dedup: skip if container dimensions haven't meaningfully changed.
    // This prevents feedback loops where fitAddon.fit() adjusts xterm's
    // internal canvas, triggering another ResizeObserver notification.
    // A 3px threshold filters out sub-character noise (scrollbar appearance,
    // layout micro-shifts during agent output) that would cause canvas flicker.
    const entry = entries[0];
    const w = entry?.contentRect?.width ?? container.offsetWidth;
    const h = entry?.contentRect?.height ?? container.offsetHeight;
    if (Math.abs(w - lastContainerWidth) < 3 && Math.abs(h - lastContainerHeight) < 3) return;
    lastContainerWidth = w;
    lastContainerHeight = h;

    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
      // Check proposed dimensions BEFORE calling fit() — fitAddon.fit()
      // triggers a canvas repaint even when cols/rows don't change, which
      // causes visible flicker during rapid agent output. proposeDimensions()
      // calculates what fit() would produce without touching the canvas.
      const proposed = fitAddon.proposeDimensions();
      if (proposed && proposed.cols === term.cols && proposed.rows === term.rows) return;
      // Guard: reject implausible dimensions from mid-transition containers
      if (proposed && (proposed.cols < 10 || proposed.rows < 2)) return;
      const wasTerminalFocused = !isMobile.value && !!textarea && document.activeElement === textarea;
      fitAddon.fit();
      wsSend({ type: 'console:resize', sessionId, cols: term.cols, rows: term.rows });
      if (wasTerminalFocused && document.activeElement !== textarea) {
        term.focus();
      }
      // Scroll to bottom after fit — same JS task, single browser paint
      if (!scrollLocked.get(sessionId)) {
        suppressScrollEvents(sessionId);
        term.scrollToBottom();
      }
    }, isMobile.value ? 150 : 100);
  });
  resizeObserver.observe(container);

  const instance: TerminalInstance = { term, fitAddon, resizeObserver, container, textarea };
  terminals.set(sessionId, instance);
  return instance;
}

export function getTerminal(sessionId: string): TerminalInstance | undefined {
  return terminals.get(sessionId);
}

/** Returns true if the user has scrolled up and auto-scroll is suspended. */
export function isScrollLocked(sessionId: string): boolean {
  return scrollLocked.get(sessionId) ?? false;
}

export function destroyTerminal(sessionId: string): void {
  const instance = terminals.get(sessionId);
  if (instance) {
    instance.resizeObserver?.disconnect();
    instance.term.dispose();
    terminals.delete(sessionId);
    scrollLocked.delete(sessionId);
    const raf = pendingScrollRaf.get(sessionId);
    if (raf) { cancelAnimationFrame(raf); pendingScrollRaf.delete(sessionId); }
  }
}

export function fitTerminal(sessionId: string): void {
  const instance = terminals.get(sessionId);
  if (!instance) return;
  // Don't fit against a hidden container — FitAddon gets 0-size dimensions
  if (instance.container.offsetWidth === 0 || instance.container.offsetHeight === 0) return;
  // Pre-check: if proposed dimensions are implausible, skip entirely.
  // This prevents fitAddon.fit() from resizing xterm to cols=1 during
  // layout transitions (especially on mobile), which causes 1-char-per-line.
  const proposed = instance.fitAddon.proposeDimensions();
  if (proposed && (proposed.cols < 10 || proposed.rows < 2)) return;
  const prevCols = instance.term.cols;
  const prevRows = instance.term.rows;
  const wasTerminalFocused = !isMobile.value && !!instance.textarea && document.activeElement === instance.textarea;
  instance.fitAddon.fit();
  // Only send console:resize if dimensions actually changed
  if (instance.term.cols !== prevCols || instance.term.rows !== prevRows) {
    if (wasTerminalFocused && document.activeElement !== instance.textarea) {
      instance.term.focus();
    }
    wsSend({ type: 'console:resize', sessionId, cols: instance.term.cols, rows: instance.term.rows });
  }
}

/**
 * Force xterm to reposition its viewport and repaint after a terminal container
 * becomes visible (e.g. display:none → display:block on tab switch).
 *
 * This function only does scroll sync + canvas refresh — both O(visible rows).
 * All call sites already call fitTerminal() first, so dims are correct.
 */
export function repaintTerminal(sessionId: string): void {
  const instance = terminals.get(sessionId);
  if (!instance) return;
  if (instance.container.offsetWidth === 0 || instance.container.offsetHeight === 0) return;
  const { rows } = instance.term;
  // Always scroll to bottom on repaint (tab switch, reconnect, keyboard open)
  scrollLocked.set(sessionId, false);
  suppressScrollEvents(sessionId);
  instance.term.scrollToBottom();
  // Direct DOM scroll as backup
  const viewport = instance.container.querySelector('.xterm-viewport') as HTMLElement | null;
  if (viewport) { suppressScrollEvents(sessionId); viewport.scrollTop = viewport.scrollHeight; }
  instance.term.refresh(0, rows - 1);
}

/**
 * Wait for the terminal container to have non-zero dimensions, then fit + repaint.
 * Solves the "black terminal" bug: when xterm is inside a display:none parent,
 * fitAddon.fit() silently no-ops (0x0 container). This function polls with rAF
 * until the container is visible, then triggers the full fit→resize→repaint cycle.
 *
 * @param maxWaitMs - Maximum time to wait for dimensions (default 2000ms)
 * @returns cleanup function that cancels pending polls
 */
export function ensureTerminalVisible(sessionId: string, maxWaitMs = 2000): () => void {
  const instance = terminals.get(sessionId);
  if (!instance) return () => {};

  let cancelled = false;
  let stabilizeTimer: ReturnType<typeof setTimeout> | null = null;

  // After the initial fit, schedule a second fit to catch layout shifts
  // (e.g., mobile: header hides, toolbar appears, keyboard opens).
  function fitAndStabilize() {
    fitTerminal(sessionId);
    requestAnimationFrame(() => repaintTerminal(sessionId));
    // Second fit after layout settles (covers mobile transitions)
    stabilizeTimer = setTimeout(() => {
      if (cancelled) return;
      if (terminals.get(sessionId)) {
        fitTerminal(sessionId);
        repaintTerminal(sessionId);
      }
    }, 300);
  }

  // If container already has dimensions, fit immediately + stabilize
  if (instance.container.offsetWidth > 0 && instance.container.offsetHeight > 0) {
    fitAndStabilize();
    return () => { cancelled = true; if (stabilizeTimer) clearTimeout(stabilizeTimer); };
  }

  // Poll until container becomes visible
  const deadline = Date.now() + maxWaitMs;

  function poll() {
    if (cancelled) return;
    const inst = terminals.get(sessionId);
    if (!inst) return;

    if (inst.container.offsetWidth > 0 && inst.container.offsetHeight > 0) {
      fitAndStabilize();
      return;
    }

    if (Date.now() < deadline) {
      requestAnimationFrame(poll);
    }
  }

  requestAnimationFrame(poll);

  return () => { cancelled = true; if (stabilizeTimer) clearTimeout(stabilizeTimer); };
}

/** Returns the current terminal dimensions, or null if not found / hidden. */
export function getTerminalDimensions(sessionId: string): { cols: number; rows: number } | null {
  const instance = terminals.get(sessionId);
  if (!instance) return null;
  return { cols: instance.term.cols, rows: instance.term.rows };
}

// Pending scroll-to-bottom per session, batched via rAF to avoid the "jump up
// then snap back" effect when many write chunks arrive in rapid succession.
// Without batching, each write callback calls scrollToBottom() independently,
// and xterm's internal buffer expansion between callbacks can temporarily move
// the viewport up — the next scrollToBottom() snaps it back, causing visible jitter.
const pendingScrollRaf = new Map<string, number>();

export function writeToTerminal(sessionId: string, data: string): void {
  const instance = terminals.get(sessionId);
  if (!instance) return;

  // Sanitize dangerous ANSI escape sequences (OSC, DCS, PM, APC) before rendering.
  const sanitized = sanitizeAnsiOutput(data);

  // Notify write subscribers (e.g., adaptive prompt detection)
  for (const listener of writeListeners) {
    try { listener(sessionId, sanitized); } catch {}
  }

  // If the user scrolled up to read history, don't yank them to the bottom.
  // Exception: during attach/replay, always follow output.
  if (scrollLocked.get(sessionId) && !attachingSession.has(sessionId)) {
    instance.term.write(sanitized);
    return;
  }

  // Write data, then schedule a single scroll-to-bottom per animation frame.
  // Multiple writes within the same frame share one scrollToBottom() call,
  // eliminating the visible up-down jitter during rapid agent output.
  instance.term.write(sanitized);
  if (!pendingScrollRaf.has(sessionId)) {
    const raf = requestAnimationFrame(() => {
      pendingScrollRaf.delete(sessionId);
      if (!scrollLocked.get(sessionId)) {
        suppressScrollEvents(sessionId);
        instance.term.scrollToBottom();
      }
    });
    pendingScrollRaf.set(sessionId, raf);
  }
}

export function focusTerminal(sessionId: string): void {
  const instance = terminals.get(sessionId);
  if (instance) {
    if (isMobile.value) {
      // On mobile, only re-focus hidden input if keyboard is already open
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
    suppressScrollEvents(sessionId);
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
