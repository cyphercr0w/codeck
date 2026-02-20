import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { getClaudeStatus, isClaudeAuthenticated, syncCredentialsAfterCLI } from '../services/auth-anthropic.js';
import { ACTIVE_AGENT } from '../services/agent.js';
import { getGitStatus, getWorkspacePath } from '../services/git.js';
import { getSession, writeToSession, resizeSession, destroySession, markSessionAttached, resetSessionAttachment, listSessions, hasSavedSessions } from '../services/console.js';
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
// Only cleaned up when the PTY actually exits.
const sessionExitHandlers = new Map<string, { dispose: () => void }>();

// ws → Map<sessionId, { cols, rows }> (per-client dimensions for each session)
const clientDimensions = new Map<WebSocket, Map<string, { cols: number; rows: number }>>();

// sessionId → { cols, rows } (current max dimensions applied to PTY)
const sessionMaxDimensions = new Map<string, { cols: number; rows: number }>();

// Max input payload size per WS message (64KB per OWASP recommendation)
const MAX_INPUT_SIZE = 65536;

// Per-connection message rate limiting (300 msg/min — higher than OWASP baseline of 100
// because terminal input generates rapid keystroke messages)
const WS_RATE_LIMIT = 300;
const WS_RATE_WINDOW_MS = 60000;
const messageRates = new Map<WebSocket, { count: number; resetAt: number }>();

function isRateLimited(ws: WebSocket): boolean {
  const now = Date.now();
  let rate = messageRates.get(ws);
  if (!rate || now > rate.resetAt) {
    rate = { count: 0, resetAt: now + WS_RATE_WINDOW_MS };
  }
  rate.count++;
  messageRates.set(ws, rate);
  return rate.count > WS_RATE_LIMIT;
}

let wss: WebSocketServer;

export function setupWebSocket(): void {
  wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 }); // 64KB per OWASP recommendation

  // --- Server-side ping/pong keepalive ---
  // Detects dead clients (e.g. mobile network drop) and terminates them.
  // Browser WebSocket auto-responds to ping frames with pong.
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

  // Send application-level heartbeat so the client can detect stale connections
  // (browser JS can't see protocol-level ping frames)
  const heartbeatInterval = setInterval(() => {
    broadcast({ type: 'heartbeat' });
  }, 25000);

  // Monitor Claude auth state — detect token expiry between explicit status broadcasts.
  // When isClaudeAuthenticated() flips to false, broadcast status immediately so the
  // frontend's claudeAuthenticated signal updates and the LoginModal auto-opens.
  let lastAuthState: boolean | null = null;
  const authMonitorInterval = setInterval(() => {
    if (clients.length === 0) return;
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
  });

  const INTERNAL_SECRET = process.env.CODECK_INTERNAL_SECRET || '';

  wss.on('connection', (ws, req) => {
    // Auth validation for WebSocket
    if (isPasswordConfigured()) {
      const url = new URL(req.url || '', `http://${req.headers.host}`);

      // Trusted proxy bypass — daemon has already authenticated the WS connection
      const internalParam = url.searchParams.get('_internal');
      const isTrustedProxy = INTERNAL_SECRET && internalParam === INTERNAL_SECRET;

      if (!isTrustedProxy) {
        const ticket = url.searchParams.get('ticket');
        const token = url.searchParams.get('token');

        // Prefer one-time ticket (short-lived, consumed on use — avoids long-lived token in URL)
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
        pendingRestore: hasSavedSessions(),
        dockerExperimental: detectDockerSocketMount(),
      },
    }));
    ws.send(JSON.stringify({ type: 'logs', data: getLogBuffer() }));

    // Console messages
    ws.on('message', (raw) => {
      if (isRateLimited(ws)) return; // Drop messages exceeding rate limit
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
      messageRates.delete(ws);
      setWsClients(clients);

      // Remove this client from all session client sets
      for (const [sessionId, clientSet] of sessionClients) {
        clientSet.delete(ws);
        if (clientSet.size === 0) {
          // No clients left — dispose only the data handler.
          // The exit handler (sessionExitHandlers) stays alive so PTY death is
          // detected even when no browser tab is connected.
          const dataHandler = sessionHandlers.get(sessionId);
          if (dataHandler) {
            dataHandler.dispose();
            sessionHandlers.delete(sessionId);
          }
          // Reset attachment so future PTY output is buffered again.
          // On next console:attach, markSessionAttached replays the buffer.
          resetSessionAttachment(sessionId);
          sessionClients.delete(sessionId);
          sessionMaxDimensions.delete(sessionId);
        } else {
          // Recalculate max dimensions with remaining clients
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

// Note: WS message-level authorization (per-session ownership) is intentionally
// not implemented. Codeck is a single-user sandbox — all authenticated clients
// have equal access to all sessions. If multi-user support is added, session
// ownership tracking and per-message authorization should be implemented.
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

    // Add this client to the session's client set
    let clientSet = sessionClients.get(msg.sessionId);
    if (!clientSet) {
      clientSet = new Set();
      sessionClients.set(msg.sessionId, clientSet);
    }
    clientSet.add(ws);

    const sid = msg.sessionId; // capture for closures

    // Exit handler: created once per session, kept alive even when no WS clients are
    // connected.  This ensures PTY death is always detected (e.g. Claude exits while
    // the user has no browser tab open).
    if (!sessionExitHandlers.has(sid)) {
      const exitDisposable = session.pty.onExit(({ exitCode }: { exitCode: number }) => {
        const currentClients = sessionClients.get(sid);
        if (currentClients) {
          const payload = JSON.stringify({ type: 'console:exit', sessionId: sid, exitCode });
          for (const client of currentClients) {
            if (client.readyState === WebSocket.OPEN) client.send(payload);
          }
        }
        // Sync credentials — CLI may have refreshed the OAuth token during the session.
        // Broadcast status so the frontend's claudeAuthenticated signal stays accurate
        // (e.g. if the token expired and Claude exited, the LoginModal opens).
        syncCredentialsAfterCLI();
        broadcastStatus();
        // Clean up all tracking for this session.
        // Note: no need to call .dispose() on the exit handler here — this callback
        // IS the handler; it has already fired and cannot fire again.
        sessionExitHandlers.delete(sid);
        sessionHandlers.delete(sid);
        sessionClients.delete(sid);
        sessionMaxDimensions.delete(sid);
        destroySession(sid);
      });
      sessionExitHandlers.set(sid, exitDisposable);
    }

    // Data handler: created when the first client attaches (or re-created after all
    // clients disconnected and the session is being re-attached on WS reconnect).
    if (!sessionHandlers.has(sid)) {
      const dataDisposable = session.pty.onData((data: string) => {
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

    // Replay any output buffered while no WS client was connected.
    // markSessionAttached clears the buffer and sets session.attached = true so
    // future output goes directly to the data handler above (not buffered again).
    const buffered = markSessionAttached(msg.sessionId);
    for (const chunk of buffered) {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'console:output', sessionId: msg.sessionId, data: chunk }));
    }
  }

  if (msg.type === 'console:input') writeToSession(msg.sessionId, msg.data || '');

  if (msg.type === 'console:resize') {
    // Store this client's dimensions
    let dims = clientDimensions.get(ws);
    if (!dims) {
      dims = new Map();
      clientDimensions.set(ws, dims);
    }
    dims.set(msg.sessionId, { cols: msg.cols || 80, rows: msg.rows || 24 });

    // Resize PTY to max of all clients' dimensions (prevents mobile shrinking PC)
    recalcMaxDimensions(msg.sessionId);
  }
}

/** Handle WebSocket upgrade for the main /ws endpoint (origin validation + auth). */
export function handleWsUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
  // Origin header validation — defense-in-depth against Cross-Site WebSocket Hijacking
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
