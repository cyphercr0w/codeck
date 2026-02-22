/**
 * Internal per-session PTY WebSocket endpoint: /internal/pty/:id
 *
 * Used by the daemon in gateway mode to proxy PTY connections.
 * Each WebSocket connection maps to exactly one PTY session (session ID from URL).
 * No auth — internal endpoint, runtime is never exposed directly in gateway mode.
 *
 * Protocol (simplified, no sessionId in messages since it's implicit):
 *   Client → Server:  { type: "input", data: "..." }
 *                      { type: "resize", cols: N, rows: N }
 *   Server → Client:  { type: "output", data: "..." }
 *                      { type: "exit", exitCode: N }
 *                      { type: "error", message: "..." }
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import {
  getSession, writeToSession, resizeSession, markSessionAttached, destroySession,
} from '../services/console.js';
import { syncCredentialsAfterCLI } from '../services/auth-anthropic.js';

// Max input payload size per WS message (64KB per OWASP recommendation)
const MAX_INPUT_SIZE = 65536;

// Rate limiting removed — single-user terminal app where 300 msg/min was too low
// for normal typing speed. MaxPayload (64KB) is sufficient protection.

// UUID v4 pattern for session ID validation
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// --- Per-session multi-client tracking (same pattern as websocket.ts) ---
const sessionClients = new Map<string, Set<WebSocket>>();
const sessionHandlers = new Map<string, Array<{ dispose: () => void }>>();
const clientDimensions = new Map<WebSocket, Map<string, { cols: number; rows: number }>>();
const sessionMaxDimensions = new Map<string, { cols: number; rows: number }>();
let wss: WebSocketServer;

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

function handleMessage(ws: WebSocket, sessionId: string, msg: { type: string; data?: string; cols?: number; rows?: number }): void {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

  if (msg.type === 'input') {
    if (typeof msg.data === 'string' && msg.data.length <= MAX_INPUT_SIZE) {
      writeToSession(sessionId, msg.data);
    }
  }

  if (msg.type === 'resize') {
    const c = Number(msg.cols), r = Number(msg.rows);
    if (!Number.isInteger(c) || !Number.isInteger(r) || c < 1 || c > 500 || r < 1 || r > 200) return;

    let dims = clientDimensions.get(ws);
    if (!dims) {
      dims = new Map();
      clientDimensions.set(ws, dims);
    }
    dims.set(sessionId, { cols: c, rows: r });
    recalcMaxDimensions(sessionId);
  }
}

export function setupInternalPty(): void {
  wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  // Ping/pong keepalive — detect dead connections
  setInterval(() => {
    for (const client of wss.clients) {
      if ((client as any)._isAlive === false) {
        console.log('[Internal PTY] Terminating stale client');
        client.terminate();
        continue;
      }
      (client as any)._isAlive = false;
      client.ping();
    }
  }, 30000);

  wss.on('connection', (ws, req) => {
    // Extract session ID from URL: /internal/pty/<uuid>
    const pathname = (req.url || '').split('?')[0];
    const parts = pathname.split('/');
    // Expected: ['', 'internal', 'pty', '<uuid>']
    const sessionId = parts[3];

    if (!sessionId || !UUID_RE.test(sessionId)) {
      ws.close(4000, 'Invalid session ID');
      return;
    }

    const session = getSession(sessionId);
    if (!session) {
      ws.close(4004, 'Session not found');
      return;
    }

    (ws as any)._isAlive = true;
    ws.on('pong', () => { (ws as any)._isAlive = true; });

    console.log(`[Internal PTY] Client connected to session ${sessionId}`);

    // Auto-attach: add this client to the session's client set
    let clientSet = sessionClients.get(sessionId);
    if (!clientSet) {
      clientSet = new Set();
      sessionClients.set(sessionId, clientSet);
    }
    clientSet.add(ws);

    // Create PTY data/exit handlers if this is the first client for this session
    if (!sessionHandlers.has(sessionId)) {
      const dataDisposable = session.pty.onData((data: string) => {
        const currentClients = sessionClients.get(sessionId);
        if (!currentClients) return;

        const payload = JSON.stringify({ type: 'output', data });
        for (const client of currentClients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(payload, (err) => {
              if (err) console.warn('[Internal PTY] Send error:', sessionId, err.message);
            });
          }
        }
      });

      const exitDisposable = session.pty.onExit(({ exitCode }: { exitCode: number }) => {
        const currentClients = sessionClients.get(sessionId);
        if (currentClients) {
          const payload = JSON.stringify({ type: 'exit', exitCode });
          for (const client of currentClients) {
            if (client.readyState === WebSocket.OPEN) client.send(payload);
          }
        }
        syncCredentialsAfterCLI();
        sessionHandlers.delete(sessionId);
        sessionClients.delete(sessionId);
        sessionMaxDimensions.delete(sessionId);
        destroySession(sessionId);
      });

      sessionHandlers.set(sessionId, [dataDisposable, exitDisposable]);
    }

    // Replay buffered output to this client
    const buffered = markSessionAttached(sessionId);
    for (const chunk of buffered) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data: chunk }));
      }
    }

    // Handle incoming messages
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleMessage(ws, sessionId, msg);
      } catch (e) {
        console.warn('[Internal PTY] Failed to parse message:', (e as Error).message);
      }
    });

    // Cleanup on disconnect
    ws.on('close', () => {
      console.log(`[Internal PTY] Client disconnected from session ${sessionId}`);

      const set = sessionClients.get(sessionId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          const handlers = sessionHandlers.get(sessionId);
          if (handlers) {
            handlers.forEach(d => d.dispose());
            sessionHandlers.delete(sessionId);
          }
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

/** Handle WebSocket upgrade for /internal/pty/:id requests. */
export function handlePtyUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
}
