import express from 'express';
import helmet from 'helmet';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  isPasswordConfigured,
  validatePassword,
  validateSession,
  touchSession,
  invalidateSession,
  getActiveSessions,
  getSessionByToken,
  getSessionById,
  revokeSessionById,
  getAuthLog,
} from './services/auth.js';
import { audit, flushAudit } from './services/audit.js';
import {
  createAuthLimiter,
  createWritesLimiter,
  checkLockout,
  recordFailedLogin,
  clearFailedAttempts,
} from './services/rate-limit.js';
import { proxyToRuntime, getRuntimeUrl } from './services/proxy.js';
import { handleWsUpgrade, shutdownWsProxy, getWsConnectionCount, getRuntimeWsUrl } from './services/ws-proxy.js';
import {
  initDaemonPortManager, addPort, removePort, getMappedPorts, isPortExposed, isPortManagerEnabled,
} from './services/port-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.CODECK_DAEMON_PORT || '8080', 10);
// Resolve path to apps/web/dist from apps/daemon/dist/
const WEB_DIST = join(__dirname, '../../web/dist');

export async function startDaemon(): Promise<void> {
  const app = express();
  app.set('trust proxy', 1);
  const server = createServer(app);

  // Initialize port manager (requires CODECK_PROJECT_DIR)
  initDaemonPortManager();

  // Security headers — same config as runtime
  app.use(helmet({
    contentSecurityPolicy: false,
    strictTransportSecurity: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
  }));

  app.use(express.json());

  // ── Rate limiters (configurable via env vars) ──

  const authLimiter = createAuthLimiter();
  const writesLimiter = createWritesLimiter();

  // ── WebSocket upgrade handler ──

  server.on('upgrade', (req, socket, head) => {
    handleWsUpgrade(req, socket as import('net').Socket, head);
  });

  // ── Public endpoints (no auth required) ──

  // Daemon status
  app.get('/api/ui/status', (_req, res) => {
    res.json({
      status: 'ok',
      mode: 'managed',
      uptime: process.uptime(),
      wsConnections: getWsConnectionCount(),
    });
  });

  // Auth status — check if password is configured
  app.get('/api/auth/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ configured: isPasswordConfigured() });
  });

  // Login
  app.post('/api/auth/login', async (req, res) => {
    const ip = req.ip || 'unknown';

    if (!authLimiter.check(ip)) {
      res.status(429).json({ success: false, error: 'Too many requests. Try again later.' });
      return;
    }

    const lockout = checkLockout(ip);
    if (lockout.locked) {
      res.status(429).json({
        success: false,
        error: 'Too many failed attempts. Try again later.',
        retryAfter: lockout.retryAfter,
      });
      return;
    }

    const { password, deviceId } = req.body;
    if (!password) {
      res.status(400).json({ success: false, error: 'Password required' });
      return;
    }

    const result = await validatePassword(password, ip, deviceId || 'unknown');
    if (result.success) {
      clearFailedAttempts(ip);
      audit('auth.login', ip, { sessionId: result.sessionId, deviceId: result.deviceId });
      res.json({ success: true, token: result.token });
    } else {
      audit('auth.login_failure', ip, { deviceId: deviceId || null });
      recordFailedLogin(ip);
      res.status(401).json({ success: false, error: 'Incorrect password' });
    }
  });

  // ── Auth middleware (protects all /api/* below) ──

  app.use('/api', (req, res, next) => {
    if (!isPasswordConfigured()) return next();

    const token = req.headers.authorization?.replace('Bearer ', '') || (req.query.token as string | undefined);
    if (!token || !validateSession(token)) {
      res.status(401).json({ error: 'Unauthorized', needsAuth: true });
      return;
    }

    // Update lastSeen for active session
    touchSession(token);
    next();
  });

  // ── Writes rate limiter (POST/PUT/DELETE on protected routes) ──

  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    // auth/login and auth/logout already covered by authLimiter
    if (req.path.startsWith('/auth/')) return next();

    const ip = req.ip || 'unknown';
    if (!writesLimiter.check(ip)) {
      res.status(429).json({ error: 'Write rate limit exceeded. Try again later.' });
      return;
    }
    next();
  });

  // ── Protected endpoints ──

  // Logout
  app.post('/api/auth/logout', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      const session = getSessionByToken(token);
      audit('auth.logout', req.ip || 'unknown', {
        sessionId: session?.id,
        deviceId: session?.deviceId,
      });
      invalidateSession(token);
    }
    res.json({ success: true });
  });

  // WS ticket — create a short-lived one-time ticket for WebSocket auth.
  // The frontend prefers tickets over long-lived tokens in the WS URL.
  // Since the daemon proxies WS with _internal secret, the ticket is synthetic:
  // we return the daemon token itself wrapped as a "ticket" (the daemon validates
  // it in the WS upgrade handler just like a regular token).
  app.post('/api/auth/ws-ticket', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    // Token is valid (already checked by the /api auth middleware above).
    // Return it as the "ticket" — daemon WS handler accepts the same token.
    res.json({ ticket: token });
  });

  // List active sessions
  app.get('/api/auth/sessions', (req, res) => {
    const currentToken = req.headers.authorization?.replace('Bearer ', '');
    res.json({ sessions: getActiveSessions(currentToken) });
  });

  // Revoke a session by ID
  app.delete('/api/auth/sessions/:id', (req, res) => {
    const targetSession = getSessionById(req.params.id);
    const revoked = revokeSessionById(req.params.id);
    if (!revoked) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const currentToken = req.headers.authorization?.replace('Bearer ', '');
    const currentSession = currentToken ? getSessionByToken(currentToken) : undefined;
    audit('auth.session_revoked', req.ip || 'unknown', {
      sessionId: currentSession?.id,
      deviceId: currentSession?.deviceId,
      metadata: {
        revokedSessionId: targetSession?.id,
        revokedDeviceId: targetSession?.deviceId,
      },
    });
    res.json({ success: true });
  });

  // Auth event log
  app.get('/api/auth/log', (_req, res) => {
    res.json({ events: getAuthLog() });
  });

  // ── Daemon-owned port management routes (not proxied) ──

  app.get('/api/ports', (_req, res) => {
    if (!isPortManagerEnabled()) {
      // Fallback: proxy to runtime (it may have its own port detection)
      return proxyToRuntime(_req, res);
    }
    res.json({ ports: getMappedPorts() });
  });

  app.post('/api/system/add-port', (req, res) => {
    if (!isPortManagerEnabled()) {
      return proxyToRuntime(req, res);
    }
    const { port } = req.body;
    if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
      res.status(400).json({ error: 'Invalid port number (1-65535)' });
      return;
    }
    const result = addPort(port);
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  });

  app.post('/api/system/remove-port', (req, res) => {
    if (!isPortManagerEnabled()) {
      return proxyToRuntime(req, res);
    }
    const { port } = req.body;
    if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
      res.status(400).json({ error: 'Invalid port number (1-65535)' });
      return;
    }
    const result = removePort(port);
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  });

  // ── Proxy: forward all remaining /api/* to runtime ──

  app.use('/api', (req, res) => {
    proxyToRuntime(req, res);
  });

  // ── Static files & SPA ──

  // Serve static web assets (same caching strategy as runtime)
  app.use(express.static(WEB_DIST, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (filePath.includes('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));

  // SPA catch-all — serve index.html for client-side routing
  app.get('*', (_req, res) => {
    res.sendFile(join(WEB_DIST, 'index.html'));
  });

  // Error handler
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`[Daemon] Error: ${req.method} ${req.path}: ${err.message}`);
    const status = (err as Error & { statusCode?: number }).statusCode || 500;
    const message = status >= 500 ? 'Internal server error' : err.message;
    res.status(status).json({ error: message });
  });

  // Graceful shutdown
  function gracefulShutdown(signal: string): void {
    console.log(`[Daemon] Received ${signal}, shutting down...`);
    shutdownWsProxy();
    authLimiter.destroy();
    writesLimiter.destroy();
    flushAudit();
    server.close(() => {
      console.log('[Daemon] Closed cleanly');
      process.exit(0);
    });
    setTimeout(() => {
      console.log('[Daemon] Forcing exit');
      process.exit(1);
    }, 5000);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  server.listen(PORT, () => {
    console.log(`\n[Daemon] Codeck managed mode running on :${PORT}`);
    console.log(`[Daemon] Serving web from ${WEB_DIST}`);
    console.log(`[Daemon] Proxying API to ${getRuntimeUrl()}`);
    const wsUrl = getRuntimeWsUrl();
    if (wsUrl !== getRuntimeUrl()) {
      console.log(`[Daemon] Proxying WS  to ${wsUrl}`);
    }
    console.log('');
  });
}
