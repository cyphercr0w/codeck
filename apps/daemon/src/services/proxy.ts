import { request as httpRequest, IncomingMessage } from 'http';
import type { Request, Response } from 'express';

// Runtime internal URL — in managed mode, the runtime is on a private Docker network
// Default matches the plan: codeck-runtime container on port 7777
const RUNTIME_URL = process.env.CODECK_RUNTIME_URL || 'http://codeck-runtime:7777';
const PROXY_TIMEOUT = parseInt(process.env.PROXY_TIMEOUT_MS || '30000', 10);
const INTERNAL_SECRET = process.env.CODECK_INTERNAL_SECRET || '';

// Headers that should NOT be forwarded to the runtime
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/**
 * Proxy an Express request to the runtime.
 * Strips daemon auth (runtime trusts the daemon), adds X-Forwarded-* headers.
 */
export function proxyToRuntime(req: Request, res: Response): void {
  const target = new URL(req.originalUrl, RUNTIME_URL);

  // Build forwarded headers — strip hop-by-hop and auth
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'authorization') continue; // daemon's token, not runtime's
    if (lower === 'host') continue; // will be set to runtime host
    if (value !== undefined) headers[key] = value;
  }

  // Add proxy headers
  headers['x-forwarded-for'] = req.ip || '127.0.0.1';
  headers['x-forwarded-proto'] = req.protocol;
  headers['x-forwarded-host'] = req.hostname;

  // Inject internal secret so runtime trusts this proxied request
  if (INTERNAL_SECRET) {
    headers['x-codeck-internal'] = INTERNAL_SECRET;
  }

  const proxyReq = httpRequest(
    target.href,
    {
      method: req.method,
      headers,
      timeout: PROXY_TIMEOUT,
    },
    (proxyRes: IncomingMessage) => {
      const status = proxyRes.statusCode || 502;

      // Detect redirect loop: runtime redirecting back to daemon means CODECK_INTERNAL_SECRET
      // mismatch (daemon restarted with new secret, runtime still has old one).
      // Returning 503 prevents an infinite proxy loop and surfaces a clear error.
      if (status >= 300 && status < 400) {
        const location = proxyRes.headers.location || '';
        if (location.includes('host.docker.internal') || location.includes('codeck-daemon')) {
          console.error('[Daemon/Proxy] Secret mismatch detected: runtime redirected back to daemon. Restart runtime to sync secrets.');
          proxyRes.resume(); // Drain the response body
          if (!res.headersSent) res.status(503).json({ error: 'Service temporarily unavailable — internal secret mismatch. Restart runtime.' });
          return;
        }
      }

      // Forward status and headers from runtime → client
      const resHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        const lower = key.toLowerCase();
        if (HOP_BY_HOP.has(lower)) continue;
        if (value !== undefined) resHeaders[key] = value;
      }
      res.writeHead(status, resHeaders);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    console.error(`[Daemon/Proxy] Error forwarding ${req.method} ${req.originalUrl}: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Runtime unavailable' });
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.status(504).json({ error: 'Runtime timeout' });
    }
  });

  // Forward request body
  // express.json() has already consumed the stream, so we re-serialize req.body.
  // IMPORTANT: Always forward if req.body is an object (even empty `{}`), because the
  // original Content-Type and Content-Length headers are copied to the proxy request.
  // If we skip the body but keep those headers, the runtime's express.json() hangs
  // waiting for bytes that never arrive → "request aborted" → 504.
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
    const bodyStr = JSON.stringify(req.body);
    proxyReq.setHeader('content-type', 'application/json');
    proxyReq.setHeader('content-length', Buffer.byteLength(bodyStr));
    proxyReq.end(bodyStr);
  } else {
    // No body — strip content headers to avoid confusing the runtime
    proxyReq.removeHeader('content-type');
    proxyReq.removeHeader('content-length');
    proxyReq.end();
  }
}

/** Check if the runtime is reachable. */
export function checkRuntime(): Promise<boolean> {
  return new Promise((resolve) => {
    const target = new URL('/internal/status', RUNTIME_URL);
    const req = httpRequest(target.href, { method: 'GET', timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.status === 'ok');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

export function getRuntimeUrl(): string {
  return RUNTIME_URL;
}
