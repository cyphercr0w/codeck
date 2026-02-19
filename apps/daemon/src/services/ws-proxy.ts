import { request as httpRequest, IncomingMessage } from 'http';
import type { Socket } from 'net';
import { isPasswordConfigured, validateSession, touchSession } from './auth.js';

// ── Config ──

const RUNTIME_URL = process.env.CODECK_RUNTIME_URL || 'http://codeck-runtime:7777';
const MAX_WS_CONNECTIONS = parseInt(process.env.MAX_WS_CONNECTIONS || '20', 10);
const WS_PING_INTERVAL_MS = parseInt(process.env.WS_PING_INTERVAL_MS || '30000', 10);

// ── Connection tracking ──

interface WsConnection {
  clientSocket: Socket;
  runtimeSocket: Socket;
  createdAt: number;
  lastPong: number;
}

const connections = new Set<WsConnection>();
let pingInterval: ReturnType<typeof setInterval> | null = null;

function startPingInterval(): void {
  if (pingInterval) return;
  pingInterval = setInterval(() => {
    const now = Date.now();
    for (const conn of connections) {
      // Clean up connections that didn't respond to the last ping (2x interval)
      if (now - conn.lastPong > WS_PING_INTERVAL_MS * 2.5) {
        console.log('[Daemon/WS] Closing stale connection');
        conn.clientSocket.destroy();
        conn.runtimeSocket.destroy();
        connections.delete(conn);
        continue;
      }
      // Send WebSocket ping frame to client
      sendPingFrame(conn.clientSocket);
    }
    // Stop interval if no connections
    if (connections.size === 0 && pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  }, WS_PING_INTERVAL_MS);
  pingInterval.unref();
}

/** Send a WebSocket ping frame (opcode 0x9, no payload). */
function sendPingFrame(socket: Socket): void {
  if (socket.destroyed) return;
  try {
    // WebSocket frame: FIN=1, opcode=0x9 (ping), mask=0, length=0
    socket.write(Buffer.from([0x89, 0x00]));
  } catch {
    // Ignore write errors on dead sockets
  }
}

/** Check if a buffer contains a WebSocket pong frame (opcode 0xA). */
function containsPongFrame(data: Buffer): boolean {
  // Masked pong: 0x8A followed by mask bit set (0x80+)
  // Unmasked pong: 0x8A 0x00
  for (let i = 0; i < data.length - 1; i++) {
    if (data[i] === 0x8a) return true;
  }
  return false;
}

// ── Public API ──

/**
 * Handle an HTTP upgrade request: authenticate, then proxy the WebSocket
 * connection to the runtime.
 */
export function handleWsUpgrade(
  req: IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
): void {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // Auth: validate daemon token from query param (skip if no password configured)
  if (isPasswordConfigured()) {
    const token = url.searchParams.get('token');
    if (!token || !validateSession(token)) {
      clientSocket.write(
        'HTTP/1.1 401 Unauthorized\r\n' +
        'Connection: close\r\n' +
        '\r\n',
      );
      clientSocket.destroy();
      return;
    }
    touchSession(token);
  }

  // Connection limit
  if (connections.size >= MAX_WS_CONNECTIONS) {
    clientSocket.write(
      'HTTP/1.1 503 Service Unavailable\r\n' +
      'Connection: close\r\n' +
      '\r\n',
    );
    clientSocket.destroy();
    return;
  }

  // Build the target URL for the runtime
  // Forward the path as-is (e.g., /ws, /internal/pty/:id)
  const targetUrl = new URL(url.pathname + url.search, RUNTIME_URL);
  // Remove daemon token from the proxied request
  targetUrl.searchParams.delete('token');

  const parsed = new URL(RUNTIME_URL);

  // Make an HTTP upgrade request to the runtime
  const proxyReq = httpRequest({
    hostname: parsed.hostname,
    port: parsed.port || 80,
    path: targetUrl.pathname + (targetUrl.search || ''),
    method: 'GET',
    headers: {
      'Host': `${parsed.hostname}:${parsed.port || 80}`,
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Version': req.headers['sec-websocket-version'] || '13',
      'Sec-WebSocket-Key': req.headers['sec-websocket-key'] || '',
      ...(req.headers['sec-websocket-extensions'] ? { 'Sec-WebSocket-Extensions': req.headers['sec-websocket-extensions'] } : {}),
      ...(req.headers['sec-websocket-protocol'] ? { 'Sec-WebSocket-Protocol': req.headers['sec-websocket-protocol'] } : {}),
      ...(req.headers['origin'] ? { 'Origin': req.headers['origin'] } : {}),
      'X-Forwarded-For': clientSocket.remoteAddress || '127.0.0.1',
    },
    timeout: 10_000,
  });

  proxyReq.on('upgrade', (proxyRes: IncomingMessage, runtimeSocket: Socket, proxyHead: Buffer) => {
    // Forward the 101 Switching Protocols response to the client
    let responseHeaders = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value) responseHeaders += `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`;
    }
    responseHeaders += '\r\n';
    clientSocket.write(responseHeaders);

    // Write any buffered data
    if (proxyHead.length > 0) clientSocket.write(proxyHead);
    if (head.length > 0) runtimeSocket.write(head);

    // Track connection
    const conn: WsConnection = {
      clientSocket,
      runtimeSocket,
      createdAt: Date.now(),
      lastPong: Date.now(),
    };
    connections.add(conn);
    startPingInterval();

    // Watch for pong frames from client to track liveness
    clientSocket.on('data', (data: Buffer) => {
      if (containsPongFrame(data)) {
        conn.lastPong = Date.now();
      }
    });

    // Bidirectional pipe
    clientSocket.pipe(runtimeSocket);
    runtimeSocket.pipe(clientSocket);

    // Cleanup on either side closing
    function cleanup(): void {
      connections.delete(conn);
      clientSocket.unpipe(runtimeSocket);
      runtimeSocket.unpipe(clientSocket);
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!runtimeSocket.destroyed) runtimeSocket.destroy();
    }

    clientSocket.on('close', cleanup);
    clientSocket.on('error', cleanup);
    runtimeSocket.on('close', cleanup);
    runtimeSocket.on('error', cleanup);
  });

  proxyReq.on('error', (err) => {
    console.error(`[Daemon/WS] Proxy error: ${err.message}`);
    clientSocket.write(
      'HTTP/1.1 502 Bad Gateway\r\n' +
      'Connection: close\r\n' +
      '\r\n',
    );
    clientSocket.destroy();
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    clientSocket.write(
      'HTTP/1.1 504 Gateway Timeout\r\n' +
      'Connection: close\r\n' +
      '\r\n',
    );
    clientSocket.destroy();
  });

  // If runtime responds with a non-upgrade response (e.g., 404, 401)
  proxyReq.on('response', (res: IncomingMessage) => {
    const statusLine = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
    let headers = '';
    for (const [key, value] of Object.entries(res.headers)) {
      if (value) headers += `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`;
    }
    clientSocket.write(statusLine + headers + '\r\n');
    res.pipe(clientSocket);
  });

  proxyReq.end();
}

/** Close all WS connections and stop heartbeat. */
export function shutdownWsProxy(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  for (const conn of connections) {
    conn.clientSocket.destroy();
    conn.runtimeSocket.destroy();
  }
  connections.clear();
}

/** Current active WS connection count. */
export function getWsConnectionCount(): number {
  return connections.size;
}
