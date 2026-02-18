import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { getClaudeStatus, isClaudeAuthenticated } from '../services/auth-anthropic.js';
import { ACTIVE_AGENT } from '../services/agent.js';
import { getGitStatus, getWorkspacePath } from '../services/git.js';
import { getSession, writeToSession, resizeSession, destroySession, markSessionAttached, listSessions } from '../services/console.js';
import { getLogBuffer, setWsClients, broadcast } from './logger.js';
import { isPasswordConfigured, validateSession } from '../services/auth.js';
import { detectDockerSocketMount } from '../services/environment.js';
import type { Socket } from 'net';

let clients: WebSocket[] = [];

// Track PTY event disposables per session to prevent handler stacking on re-attach
const sessionDisposables = new Map<string, Array<{ dispose: () => void }>>();

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

export function setupWebSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 }); // 64KB per OWASP recommendation

  server.on('upgrade', (req, socket, head) => {
    // Origin header validation — defense-in-depth against Cross-Site WebSocket Hijacking
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        // Allow same-origin, localhost variants, and *.codeck.local
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
        // Malformed origin header — reject
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket as Socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

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

  wss.on('close', () => {
    clearInterval(pingInterval);
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', (ws, req) => {
    // Auth validation for WebSocket
    if (isPasswordConfigured()) {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');
      if (!token || !validateSession(token)) {
        ws.close(4001, 'Unauthorized');
        return;
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
      messageRates.delete(ws); // Clean up rate tracking
      setWsClients(clients);
    });
  });
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

    // Dispose previous handlers to prevent stacking on re-attach (page refresh)
    const oldDisposables = sessionDisposables.get(msg.sessionId);
    if (oldDisposables) {
      oldDisposables.forEach(d => d.dispose());
    }

    const dataDisposable = session.pty.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        // Backpressure: pause PTY while WebSocket send is in-flight to prevent
        // unbounded buffer growth when client is slow to consume output.
        session.pty.pause();
        ws.send(JSON.stringify({ type: 'console:output', sessionId: msg.sessionId, data }), (err) => {
          // Always resume PTY regardless of send error. Leaving it paused
          // permanently freezes the terminal. If the client truly disconnected,
          // the WS close event handles cleanup.
          try { session.pty.resume(); } catch { /* session may be destroyed */ }
          if (err) console.warn('[WS] Send error for session', msg.sessionId, err.message);
        });
      }
    });
    const exitDisposable = session.pty.onExit(({ exitCode }: { exitCode: number }) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'console:exit', sessionId: msg.sessionId, exitCode }));
      sessionDisposables.delete(msg.sessionId);
      destroySession(msg.sessionId);
    });

    sessionDisposables.set(msg.sessionId, [dataDisposable, exitDisposable]);

    // Replay any buffered output from before attach
    const buffered = markSessionAttached(msg.sessionId);
    for (const chunk of buffered) {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'console:output', sessionId: msg.sessionId, data: chunk }));
    }
  }
  if (msg.type === 'console:input') writeToSession(msg.sessionId, msg.data || '');
  if (msg.type === 'console:resize') resizeSession(msg.sessionId, msg.cols || 80, msg.rows || 24);
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
