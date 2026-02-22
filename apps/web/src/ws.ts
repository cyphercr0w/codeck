import { setWsConnected, updateStateFromServer, addLog, sessions, activeSessionId, addSession, setActiveSessionId, setActivePorts, setActiveSection, setRestoringPending, type LogEntry, removeSession, updateProactiveAgent, appendAgentOutput, setAgentRunning, claudeAuthenticated } from './state/store';
import { getAuthToken } from './api';

// Known WebSocket message types — reject anything not in this set
const KNOWN_MSG_TYPES = new Set([
  'heartbeat', 'status', 'log', 'logs', 'ports', 'sessions:restored',
  'console:error', 'console:output', 'console:exit', 'console:freeze',
  'agent:update', 'agent:output', 'agent:execution:start', 'agent:execution:complete',
  'auth:expiring', 'auth:expired',
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

// True only on the first status message after a WS reconnect.
// Prevents onSessionReattached from firing on every status broadcast
// (auth monitor, session events, etc.) — it should only fire after a real reconnect.
let pendingReattach = false;

// Track which sessions have been attached on the current WS connection
// to prevent duplicate console:attach messages on reconnect.
const attachedSessions = new Set<string>();

// Buffer the last resize per session sent while disconnected.
// On reconnect, all buffered resizes are flushed so every terminal
// gets its correct dimensions — not just the last one that fired.
const pendingResizes = new Map<string, object>();

// Buffer console:input messages sent while disconnected or pre-attach so
// keystrokes aren't silently dropped during brief reconnects.
// Keyed by sessionId so inputs can be flushed per-session inside attachSession
// (AFTER console:attach is sent) rather than in onopen (BEFORE attach).
const MAX_PENDING_INPUTS = 200;
const pendingInputs = new Map<string, object[]>();

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
  const msgType = (msg as any).type;
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Buffer console:input if this session hasn't been re-attached yet.
    // Covers the pendingReattach window and the status→rAF gap (~16ms).
    if (msgType === 'console:input') {
      const sid = (msg as any).sessionId;
      if (typeof sid === 'string' && !attachedSessions.has(sid)) {
        const arr = pendingInputs.get(sid) ?? [];
        if (!pendingInputs.has(sid)) pendingInputs.set(sid, arr);
        if (arr.length < MAX_PENDING_INPUTS) arr.push(msg);
        return;
      }
    }
    ws.send(JSON.stringify(msg));
  } else if (msgType === 'console:resize') {
    // Buffer resize per session — replaces any previous buffered resize
    const sessionId = (msg as any).sessionId;
    if (typeof sessionId === 'string') {
      pendingResizes.set(sessionId, msg);
    }
  } else if (msgType === 'console:input') {
    // Buffer input so keystrokes typed during a brief disconnect aren't lost
    const sid = (msg as any).sessionId;
    if (typeof sid === 'string') {
      const arr = pendingInputs.get(sid) ?? [];
      if (arr.length < MAX_PENDING_INPUTS) {
        if (!pendingInputs.has(sid)) pendingInputs.set(sid, arr);
        arr.push(msg);
      }
    }
  }
}

/** Send console:attach only once per session per WS connection.
 *  After attaching, flushes any inputs buffered while the WS was down. */
export function attachSession(sessionId: string): void {
  if (attachedSessions.has(sessionId)) return;
  attachedSessions.add(sessionId);
  wsSend({ type: 'console:attach', sessionId });

  // Flush pending inputs after a brief delay so the server can process
  // the attach and register this client in sessionClients first.
  const pending = pendingInputs.get(sessionId);
  if (pending && pending.length > 0) {
    pendingInputs.delete(sessionId);
    addLog({ type: 'info', message: `[WS] Flushing ${pending.length} buffered input(s) for session ${sessionId.slice(0, 8)}`, timestamp: Date.now() });
    setTimeout(() => {
      for (const msg of pending) wsSend(msg);
    }, 100);
  }
}

function openWs(wsUrl: string): void {
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setWsConnected(true);
    lastMessageAt = Date.now();
    reconnectBackoff = 500;
    reconnectAttempts = 0;
    attachedSessions.clear();
    pendingReattach = true;
    addLog({ type: 'info', message: 'Connected to server', timestamp: Date.now() });

    // Flush all buffered resize messages
    for (const msg of pendingResizes.values()) {
      ws!.send(JSON.stringify(msg));
    }
    pendingResizes.clear();
    // pendingInputs are flushed per-session inside attachSession()

    // Stale connection detector
    if (staleCheckTimer) clearInterval(staleCheckTimer);
    staleCheckTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > 45000) {
        console.warn('[WS] Connection stale (no data in 45s), reconnecting');
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
      if (msg.type === 'heartbeat') return;
      if (msg.type === 'status') {
        if (typeof msg.data !== 'object' || msg.data === null) return;
        updateStateFromServer(msg.data);
        // Only reattach terminals on the first status after a real WS reconnect
        if (pendingReattach) {
          pendingReattach = false;
          sessions.value.forEach(s => {
            onSessionReattached?.(s.id);
          });
        }
        if (!msg.data.pendingRestore) {
          setRestoringPending(false);
        }
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
        }
        if (restored.length > 0) {
          if (!activeSessionId.value) setActiveSessionId(restored[0].id);
          setActiveSection('claude');
        }
        setRestoringPending(false);
      } else if (msg.type === 'console:error') {
        if (typeof msg.sessionId === 'string') {
          removeSession(msg.sessionId);
        }
      } else if (msg.type === 'console:output') {
        if (typeof msg.sessionId === 'string' && typeof msg.data === 'string') {
          onOutput?.(msg.sessionId, msg.data);
        }
      } else if (msg.type === 'console:freeze') {
        // Server detected PTY freeze — log diagnostic info
        if (typeof msg.sessionId === 'string') {
          const dur = typeof msg.durationMs === 'number' ? Math.round(msg.durationMs / 1000) : '?';
          const alive = msg.ptyAlive ? 'alive' : 'DEAD';
          const lag = typeof msg.eventLoopLagMs === 'number' ? msg.eventLoopLagMs : '?';
          addLog('warn', `Terminal freeze: ${dur}s (PTY: ${alive}, event loop lag: ${lag}ms)`);
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
      } else if (msg.type === 'auth:expiring') {
        const minutes = typeof msg.data?.minutesLeft === 'number' ? msg.data.minutesLeft : '?';
        addLog({ type: 'warn', message: `Claude session expires in ${minutes} minutes. Please re-login to avoid interruptions.`, timestamp: Date.now() });
      } else if (msg.type === 'auth:expired') {
        claudeAuthenticated.value = false;
      }
    } catch (err) {
      console.warn('[WS] Failed to parse message:', err);
    }
  };

  ws.onclose = () => {
    setWsConnected(false);
    ws = null;
    if (staleCheckTimer) { clearInterval(staleCheckTimer); staleCheckTimer = null; }

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      addLog({ type: 'error', message: 'Unable to reach server after multiple attempts', timestamp: Date.now() });
      setRestoringPending(false);
      return;
    }

    const delay = reconnectAttempts === 0 ? 50 : reconnectBackoff * (0.5 + Math.random() * 0.5);
    reconnectAttempts++;
    reconnectTimer = setTimeout(connectWebSocket, delay);
    reconnectBackoff = Math.min(reconnectBackoff * 2, 15000);
  };

  ws.onerror = () => ws?.close();
}

export function connectWebSocket(): void {
  if (ws && ws.readyState !== WebSocket.CLOSED) return;

  const token = getAuthToken();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

  if (!token) {
    openWs(`${protocol}//${location.host}`);
    return;
  }

  fetch('/api/auth/ws-ticket', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      const wsUrl = data?.ticket
        ? `${protocol}//${location.host}?ticket=${encodeURIComponent(data.ticket)}`
        : `${protocol}//${location.host}?token=${encodeURIComponent(token)}`;
      openWs(wsUrl);
    })
    .catch(() => openWs(`${protocol}//${location.host}?token=${encodeURIComponent(token)}`));
}

export function disconnectWebSocket(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (staleCheckTimer) { clearInterval(staleCheckTimer); staleCheckTimer = null; }
  ws?.close();
  ws = null;
}
