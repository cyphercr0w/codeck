import { setWsConnected, updateStateFromServer, addLog, sessions, activeSessionId, addSession, setActiveSessionId, setActivePorts, setActiveSection, setRestoringPending, type LogEntry, removeSession, updateProactiveAgent, appendAgentOutput, setAgentRunning } from './state/store';
import { getAuthToken } from './api';

// Known WebSocket message types — reject anything not in this set
const KNOWN_MSG_TYPES = new Set([
  'heartbeat', 'status', 'log', 'logs', 'ports', 'sessions:restored',
  'console:error', 'console:output', 'console:exit',
  'agent:update', 'agent:output', 'agent:execution:start', 'agent:execution:complete',
]);

/** Runtime validation for incoming WebSocket messages */
function isValidWsMessage(msg: unknown): msg is { type: string; [k: string]: unknown } {
  return typeof msg === 'object' && msg !== null && typeof (msg as any).type === 'string'
    && KNOWN_MSG_TYPES.has((msg as any).type);
}

function isLogEntry(data: unknown): data is LogEntry {
  return typeof data === 'object' && data !== null
    && typeof (data as any).type === 'string'
    && typeof (data as any).message === 'string'
    && typeof (data as any).timestamp === 'number';
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let staleCheckTimer: ReturnType<typeof setInterval> | null = null;
let lastMessageAt = 0;
let reconnectBackoff = 500; // Exponential backoff: 0.5s → 1s → 2s → ... → 15s cap
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 15;

// Track which sessions have been attached on the current WS connection
// to prevent duplicate console:attach messages on reconnect.
const attachedSessions = new Set<string>();

// Buffer the last resize per session sent while disconnected.
// On reconnect, all buffered resizes are flushed so every terminal
// gets its correct dimensions — not just the last one that fired.
const pendingResizes = new Map<string, object>();

// Called after each session is re-attached on reconnect, so the
// terminal layer can resync PTY dimensions for that session.
let onSessionReattached: ((sessionId: string) => void) | null = null;
export function setOnSessionReattached(handler: (sessionId: string) => void): void {
  onSessionReattached = handler;
}

type OutputHandler = (sessionId: string, data: string) => void;
type ExitHandler = (sessionId: string) => void;

let onOutput: OutputHandler | null = null;
let onExit: ExitHandler | null = null;

export function setTerminalHandlers(output: OutputHandler, exit: ExitHandler): void {
  onOutput = output;
  onExit = exit;
}

export function wsSend(msg: object): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else if ((msg as any).type === 'console:resize') {
    // Buffer resize per session — replaces any previous buffered resize for
    // this session. On reconnect, all sessions get their dimensions flushed.
    const sessionId = (msg as any).sessionId;
    if (typeof sessionId === 'string') {
      pendingResizes.set(sessionId, msg);
    }
  }
}

/** Send console:attach only once per session per WS connection.
 *  Prevents duplicate attach when multiple code paths fire on reconnect. */
export function attachSession(sessionId: string): void {
  if (attachedSessions.has(sessionId)) return;
  attachedSessions.add(sessionId);
  wsSend({ type: 'console:attach', sessionId });
}

export function connectWebSocket(): void {
  if (ws && ws.readyState !== WebSocket.CLOSED) return;

  const token = getAuthToken();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}${token ? '?token=' + encodeURIComponent(token) : ''}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setWsConnected(true);
    lastMessageAt = Date.now();
    reconnectBackoff = 500; // Reset backoff on successful connection
    reconnectAttempts = 0;
    attachedSessions.clear(); // New connection — reset attach tracking
    addLog({ type: 'info', message: 'Connected to server', timestamp: Date.now() });
    // Don't re-attach here — wait for the 'status' message which includes
    // the server's current session list. Attaching stale IDs after a
    // container restart causes frozen terminals.

    // Flush all buffered resize messages (one per session) so every terminal
    // gets its correct dimensions on reconnect, not just the last one.
    for (const msg of pendingResizes.values()) {
      ws!.send(JSON.stringify(msg));
    }
    pendingResizes.clear();

    // Start stale connection detector — if server stops sending heartbeats,
    // the connection is dead and we need to reconnect.
    if (staleCheckTimer) clearInterval(staleCheckTimer);
    staleCheckTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > 45000) {
        console.log('[WS] Connection stale (no data in 45s), reconnecting');
        ws.close();
      }
    }, 10000);
  };

  ws.onmessage = (e) => {
    lastMessageAt = Date.now();
    try {
      const raw = JSON.parse(e.data);
      if (!isValidWsMessage(raw)) {
        console.warn('[WS] Unknown or malformed message type:', raw?.type);
        return;
      }
      const msg = raw as { type: string; data?: any; sessionId?: string };
      // Ignore server heartbeats — they're just for stale detection
      if (msg.type === 'heartbeat') return;
      if (msg.type === 'status') {
        if (typeof msg.data !== 'object' || msg.data === null) return;
        updateStateFromServer(msg.data);
        // After state sync, re-attach all current sessions and notify
        // the terminal layer so it can resync PTY dimensions per session.
        sessions.value.forEach(s => {
          attachSession(s.id);
          onSessionReattached?.(s.id);
        });
        // Always clear the restoring overlay after a successful status sync.
        // The overlay is set on WS disconnect (if sessions were active) and must
        // be cleared here — updateStateFromServer only sets it to true, never false,
        // so without this the overlay would stay stuck after a normal reconnect.
        setRestoringPending(false);
      } else if (msg.type === 'log') {
        if (!isLogEntry(msg.data)) return;
        addLog(msg.data);
      } else if (msg.type === 'logs') {
        if (!Array.isArray(msg.data)) return;
        msg.data.filter(isLogEntry).forEach(entry => addLog(entry));
      } else if (msg.type === 'ports') {
        if (!Array.isArray(msg.data)) return;
        setActivePorts(msg.data);
      } else if (msg.type === 'sessions:restored') {
        if (!Array.isArray(msg.data)) return;
        const restored = msg.data.filter(
          (s: any) => typeof s.id === 'string' && typeof s.cwd === 'string' && typeof s.name === 'string'
        );
        for (const s of restored) {
          addSession({ id: s.id, type: s.type as 'agent' | 'shell', cwd: s.cwd, name: s.name, createdAt: Date.now() });
          // Do NOT call attachSession here — the terminal DOM element doesn't exist yet.
          // ClaudeSection's useEffect handles attachment after it mounts the terminal.
        }
        if (restored.length > 0) {
          if (!activeSessionId.value) setActiveSessionId(restored[0].id);
          setActiveSection('claude');
        }
        // Always clear the overlay immediately — don't wait for ClaudeSection's useEffect.
        // Delegating to the useEffect is fragile: if it doesn't fire (e.g. section already
        // mounted, same sessionList.length), the overlay stays stuck forever.
        setRestoringPending(false);
      } else if (msg.type === 'console:error') {
        // Session not found on server (e.g., after container restart) — remove ghost
        if (typeof msg.sessionId === 'string') {
          removeSession(msg.sessionId);
        }
      } else if (msg.type === 'console:output') {
        if (typeof msg.sessionId === 'string' && typeof msg.data === 'string') {
          onOutput?.(msg.sessionId, msg.data);
        }
      } else if (msg.type === 'console:exit') {
        if (typeof msg.sessionId === 'string') {
          onExit?.(msg.sessionId);
        }
      } else if (msg.type === 'agent:update') {
        if (typeof msg.data === 'object' && msg.data !== null && typeof msg.data.id === 'string') {
          updateProactiveAgent(msg.data);
        }
      } else if (msg.type === 'agent:output') {
        if (typeof msg.data?.agentId === 'string' && typeof msg.data?.text === 'string') {
          appendAgentOutput(msg.data.agentId, msg.data.text);
        }
      } else if (msg.type === 'agent:execution:start') {
        if (typeof msg.data?.agentId === 'string') {
          setAgentRunning(msg.data.agentId, true);
        }
      } else if (msg.type === 'agent:execution:complete') {
        if (typeof msg.data?.agentId === 'string') {
          setAgentRunning(msg.data.agentId, false);
        }
      }
    } catch (err) {
      console.warn('[WS] Failed to parse message:', err);
    }
  };

  ws.onclose = () => {
    setWsConnected(false);
    // If sessions were active, assume they'll need to be restored on reconnect.
    // Set restoringPending immediately so the overlay shows "Restoring sessions..."
    // as soon as the WS comes back — eliminating the gap between reconnection
    // and the server's pendingRestore status message arriving.
    if (sessions.value.length > 0) {
      setRestoringPending(true);
    }
    ws = null;
    if (staleCheckTimer) { clearInterval(staleCheckTimer); staleCheckTimer = null; }

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      addLog({ type: 'error', message: 'Unable to reach server after multiple attempts', timestamp: Date.now() });
      setRestoringPending(false);
      return; // Stop retrying — user can reload or the overlay shows failure
    }

    // First attempt: near-instant (50ms). Subsequent attempts: exponential backoff.
    const delay = reconnectAttempts === 0 ? 50 : reconnectBackoff * (0.5 + Math.random() * 0.5);
    reconnectAttempts++;
    reconnectTimer = setTimeout(connectWebSocket, delay);
    reconnectBackoff = Math.min(reconnectBackoff * 2, 15000);
  };

  ws.onerror = () => ws?.close();
}

export function disconnectWebSocket(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (staleCheckTimer) { clearInterval(staleCheckTimer); staleCheckTimer = null; }
  ws?.close();
  ws = null;
}
