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

    // On mobile, disable xterm's textarea so our hidden input takes over.
    // Track recent touch on the terminal container to distinguish user taps
    // from programmatic focus (e.g. xterm auto-focusing after data output).
    // Keyboard should only open on explicit user taps, not on data flow.
    if (isMobile.value) {
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
      if (screen) {
        screen.style.pointerEvents = 'none';
      }

      // Scroll lock: detect when user scrolls up to read history.
      // When locked, writeToTerminal preserves their scroll position.
      const viewport = container.querySelector('.xterm-viewport') as HTMLElement | null;
      if (viewport) {
        viewport.addEventListener('scroll', () => {
          const atBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 10;
          scrollLocked.set(sessionId, !atBottom);
        }, { passive: true });
      }

      // NOTE: visualViewport.resize is handled exclusively by MobileTerminalToolbar.
      // It recalculates the container height first, then the ResizeObserver on the
      // container triggers fitAddon.fit() + console:resize. Having a handler here
      // too caused a race condition (fit before container height was adjusted).
    }
  }

  term.onData((data) => {
    wsSend({ type: 'console:input', sessionId, data });
  });

  // Debounce resize to avoid excessive events on mobile orientation changes
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        fitAddon.fit();
        wsSend({ type: 'console:resize', sessionId, cols: term.cols, rows: term.rows });
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
  instance.fitAddon.fit();
  wsSend({ type: 'console:resize', sessionId, cols: instance.term.cols, rows: instance.term.rows });
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

  // On mobile with scroll lock: user scrolled up to read history.
  // Save viewport scrollTop before write, restore after xterm renders.
  // This defeats xterm's internal auto-scroll on term.write().
  if (isMobile.value && scrollLocked.get(sessionId)) {
    const viewport = instance.term.element?.querySelector('.xterm-viewport') as HTMLElement | null;
    if (viewport) {
      const savedTop = viewport.scrollTop;
      instance.term.write(sanitized, () => {
        viewport.scrollTop = savedTop;
      });
      return;
    }
  }

  // Write and auto-scroll only if the viewport was already at the live area.
  // viewportY === baseY means the user is seeing the cursor line (at bottom).
  // If viewportY < baseY, the user scrolled up into scrollback — don't yank them down.
  const buf = instance.term.buffer.active;
  const atBottom = buf.viewportY >= buf.baseY;
  instance.term.write(sanitized);
  if (atBottom) instance.term.scrollToBottom();
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
