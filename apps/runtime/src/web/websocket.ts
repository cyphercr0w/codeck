import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { getClaudeStatus, isClaudeAuthenticated, syncCredentialsAfterCLI, markTokenExpired } from '../services/auth-anthropic.js';
import { ACTIVE_AGENT } from '../services/agent.js';
import { getGitStatus, getWorkspacePath } from '../services/git.js';
import { getSession, writeToSession, resizeSession, destroySession, markSessionAttached, resetSessionAttachment, listSessions, isPendingRestore } from '../services/console.js';
import { getLogBuffer, setWsClients, broadcast } from './logger.js';
import { isPasswordConfigured, validateSession, consumeWsTicket } from '../services/auth.js';
import { detectDockerSocketMount } from '../services/environment.js';
import type { Socket } from 'net';

let clients: WebSocket[] = [];

// --- Multi-client PTY session tracking ---
// Multiple clients (e.g. PC + mobile) can attach to the same PTY session.
// Output is broadcast to ALL attached clients; resize uses max dimensions.

// sessionId → Set<WebSocket> (all clients attached to this session)
const sessionClients = new Map<string, Set<WebSocket>>();

// sessionId → data disposable (ONE onData handler per session, broadcasts to all clients).
// Disposed when all WS clients disconnect; recreated on next console:attach.
const sessionHandlers = new Map<string, { dispose: () => void }>();

// sessionId → exit disposable (ONE onExit handler per session).
// Kept alive even when no WS clients are connected so PTY death is always detected.
const sessionExitHandlers = new Map<string, { dispose: () => void }>();

// ws → Map<sessionId, { cols, rows }> (per-client dimensions for each session)
const clientDimensions = new Map<WebSocket, Map<string, { cols: number; rows: number }>>();

// sessionId → { cols, rows } (current max dimensions applied to PTY)
const sessionMaxDimensions = new Map<string, { cols: number; rows: number }>();

// Max input payload size per WS message (64KB per OWASP recommendation)
const MAX_INPUT_SIZE = 65536;

// Rate limiting removed — single-user terminal app where 300 msg/min was too low
// for normal typing speed (60 WPM = 300 keystrokes/min). MaxPayload (64KB) is
// sufficient protection against abuse.

let wss: WebSocketServer;

// Auth recovery poller: started when PTY output contains an auth error.
let authRecoveryPoller: ReturnType<typeof setInterval> | null = null;

function startAuthRecoveryPoller(): void {
  if (authRecoveryPoller) return;
  console.log('[WS] Auth recovery poller started (3s interval)');
  authRecoveryPoller = setInterval(() => {
    syncCredentialsAfterCLI();
    if (isClaudeAuthenticated()) {
      console.log('[WS] Auth recovered after re-login — stopping recovery poller');
      clearInterval(authRecoveryPoller!);
      authRecoveryPoller = null;
      broadcastStatus();
    }
  }, 3000);
}

export function setupWebSocket(): void {
  wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  // --- Server-side ping/pong keepalive ---
  const pingInterval = setInterval(() => {
    for (const ws of clients) {
      if ((ws as any)._isAlive === false) {
        console.log('[WS] Terminating stale client');
        ws.terminate();
        continue;
      }
      (ws as any)._isAlive = false;
      ws.ping();
    }
  }, 30000);

  // Application-level heartbeat for client stale detection
  const heartbeatInterval = setInterval(() => {
    broadcast({ type: 'heartbeat' });
  }, 25000);

  // Monitor Claude auth state — detect token expiry between explicit status broadcasts.
  // When auth is broken, also call syncCredentialsAfterCLI() to catch in-terminal re-login.
  let lastAuthState: boolean | null = null;
  const authMonitorInterval = setInterval(() => {
    if (clients.length === 0) return;
    if (!isClaudeAuthenticated()) {
      syncCredentialsAfterCLI();
    }
    const current = isClaudeAuthenticated();
    if (current !== lastAuthState) {
      lastAuthState = current;
      broadcastStatus();
    }
  }, 15000);

  wss.on('close', () => {
    clearInterval(pingInterval);
    clearInterval(heartbeatInterval);
    clearInterval(authMonitorInterval);
    if (authRecoveryPoller) { clearInterval(authRecoveryPoller); authRecoveryPoller = null; }
  });

  const INTERNAL_SECRET = process.env.CODECK_INTERNAL_SECRET || '';

  wss.on('connection', (ws, req) => {
    // Auth validation for WebSocket
    if (isPasswordConfigured()) {
      const url = new URL(req.url || '', `http://${req.headers.host}`);

      const internalParam = url.searchParams.get('_internal');
      const isTrustedProxy = INTERNAL_SECRET && internalParam === INTERNAL_SECRET;

      if (!isTrustedProxy) {
        const ticket = url.searchParams.get('ticket');
        const token = url.searchParams.get('token');

        const authorized = ticket ? consumeWsTicket(ticket) : (!!token && validateSession(token));
        if (!authorized) {
          ws.close(4001, 'Unauthorized');
          return;
        }
      }
    }

    (ws as any)._isAlive = true;
    ws.on('pong', () => { (ws as any)._isAlive = true; });

    console.log('[WS] Client connected');
    clients.push(ws);
    setWsClients(clients);

    // Initial state + logs + sessions
    ws.send(JSON.stringify({
      type: 'status',
      data: {
        claude: getClaudeStatus(),
        git: getGitStatus(),
        workspace: getWorkspacePath(),
        agent: { name: ACTIVE_AGENT.name, id: ACTIVE_AGENT.id },
        sessions: listSessions(),
        pendingRestore: isPendingRestore(),
        dockerExperimental: detectDockerSocketMount(),
      },
    }));
    ws.send(JSON.stringify({ type: 'logs', data: getLogBuffer() }));

    // Console messages
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleConsoleMessage(ws, msg);
      } catch (e) {
        console.warn('[WS] Failed to parse client message:', (e as Error).message);
      }
    });

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
      clients = clients.filter(c => c !== ws);
      setWsClients(clients);

      for (const [sessionId, clientSet] of sessionClients) {
        clientSet.delete(ws);
        if (clientSet.size === 0) {
          const dataHandler = sessionHandlers.get(sessionId);
          if (dataHandler) {
            dataHandler.dispose();
            sessionHandlers.delete(sessionId);
          }
          resetSessionAttachment(sessionId);
          sessionClients.delete(sessionId);
          sessionMaxDimensions.delete(sessionId);
        } else {
          recalcMaxDimensions(sessionId);
        }
      }
      clientDimensions.delete(ws);
    });
  });
}

/** Recalculate max dimensions across all clients attached to a session and resize PTY if changed. */
function recalcMaxDimensions(sessionId: string): void {
  const clientSet = sessionClients.get(sessionId);
  if (!clientSet || clientSet.size === 0) return;

  let maxCols = 1, maxRows = 1;
  for (const client of clientSet) {
    const dims = clientDimensions.get(client)?.get(sessionId);
    if (dims) {
      maxCols = Math.max(maxCols, dims.cols);
      maxRows = Math.max(maxRows, dims.rows);
    }
  }

  const prev = sessionMaxDimensions.get(sessionId);
  if (!prev || prev.cols !== maxCols || prev.rows !== maxRows) {
    sessionMaxDimensions.set(sessionId, { cols: maxCols, rows: maxRows });
    resizeSession(sessionId, maxCols, maxRows);
  }
}

function handleConsoleMessage(ws: WebSocket, msg: { type: string; sessionId: string; data?: string; cols?: number; rows?: number }): void {
  // Validate message structure
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  if (typeof msg.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(msg.sessionId)) return;

  // Validate input data size to prevent memory abuse
  if (msg.type === 'console:input' && typeof msg.data === 'string' && msg.data.length > MAX_INPUT_SIZE) return;

  // Validate resize bounds
  if (msg.type === 'console:resize') {
    const c = Number(msg.cols), r = Number(msg.rows);
    if (!Number.isInteger(c) || !Number.isInteger(r) || c < 1 || c > 500 || r < 1 || r > 200) return;
    msg.cols = c;
    msg.rows = r;
  }

  if (msg.type === 'console:attach') {
    const session = getSession(msg.sessionId);
    if (!session) {
      ws.send(JSON.stringify({ type: 'console:error', sessionId: msg.sessionId, error: 'Session not found' }));
      return;
    }

    let clientSet = sessionClients.get(msg.sessionId);
    if (!clientSet) {
      clientSet = new Set();
      sessionClients.set(msg.sessionId, clientSet);
    }
    clientSet.add(ws);

    // Apply pre-stored dimensions before replay so PTY is at correct size
    if (clientDimensions.get(ws)?.has(msg.sessionId)) {
      recalcMaxDimensions(msg.sessionId);
    }

    const sid = msg.sessionId;

    // Exit handler: created once per session, kept alive even when no WS clients
    if (!sessionExitHandlers.has(sid)) {
      const exitDisposable = session.pty.onExit(({ exitCode }: { exitCode: number }) => {
        const currentClients = sessionClients.get(sid);
        if (currentClients) {
          const payload = JSON.stringify({ type: 'console:exit', sessionId: sid, exitCode });
          for (const client of currentClients) {
            if (client.readyState === WebSocket.OPEN) client.send(payload);
          }
        }
        syncCredentialsAfterCLI();
        broadcastStatus();
        sessionExitHandlers.delete(sid);
        sessionHandlers.delete(sid);
        sessionClients.delete(sid);
        sessionMaxDimensions.delete(sid);
        destroySession(sid);
      });
      sessionExitHandlers.set(sid, exitDisposable);
    }

    // Data handler: created when the first client attaches
    if (!sessionHandlers.has(sid)) {
      const dataDisposable = session.pty.onData((data: string) => {
        // Detect OAuth token revocation errors in real-time
        if (data.includes('OAuth token revoked') || data.includes('Please run /login')) {
          if (isClaudeAuthenticated()) {
            console.log(`[WS] Auth error in PTY output for session ${sid.slice(0, 8)} but token is valid — skipping markTokenExpired`);
            startAuthRecoveryPoller();
          } else {
            console.log(`[WS] Auth error detected in PTY output for session ${sid.slice(0, 8)} — marking token expired`);
            markTokenExpired();
            broadcastStatus();
            startAuthRecoveryPoller();
          }
        }

        const currentClients = sessionClients.get(sid);
        if (!currentClients) return;

        const payload = JSON.stringify({ type: 'console:output', sessionId: sid, data });
        for (const client of currentClients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(payload, (err) => {
              if (err) console.warn('[WS] Send error for session', sid, err.message);
            });
          }
        }
      });
      sessionHandlers.set(sid, dataDisposable);
    }

    // Replay buffered output
    const buffered = markSessionAttached(msg.sessionId);
    for (const chunk of buffered) {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'console:output', sessionId: msg.sessionId, data: chunk }));
    }
  }

  if (msg.type === 'console:input') writeToSession(msg.sessionId, msg.data || '');

  if (msg.type === 'console:resize') {
    let dims = clientDimensions.get(ws);
    if (!dims) {
      dims = new Map();
      clientDimensions.set(ws, dims);
    }
    dims.set(msg.sessionId, { cols: msg.cols || 80, rows: msg.rows || 24 });

    recalcMaxDimensions(msg.sessionId);
  }
}

/** Handle WebSocket upgrade for the main /ws endpoint (origin validation + auth). */
export function handleWsUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      const isAllowed = originHost === host
        || originHost.includes('localhost')
        || originHost.endsWith('.codeck.local')
        || originHost === 'codeck.local';
      if (!isAllowed) {
        console.warn(`[WS] Rejected upgrade: origin "${origin}" does not match host "${host}"`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
}

export function broadcastStatus(): void {
  broadcast({
    type: 'status',
    data: {
      claude: getClaudeStatus(),
      git: getGitStatus(),
      agent: { name: ACTIVE_AGENT.name, id: ACTIVE_AGENT.id },
      sessions: listSessions(),
      dockerExperimental: detectDockerSocketMount(),
    },
  });
}
