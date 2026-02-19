import express from 'express';
import helmet from 'helmet';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import v8 from 'v8';
import { installLogInterceptor, getLogBuffer, broadcast } from './logger.js';
import { setupWebSocket } from './websocket.js';
import { isPasswordConfigured, setupPassword, validatePassword, validateSession, invalidateSession, changePassword } from '../services/auth.js';
import { getClaudeStatus, isClaudeAuthenticated, getAccountInfo, startTokenRefreshMonitor, stopTokenRefreshMonitor } from '../services/auth-anthropic.js';
import { ACTIVE_AGENT } from '../services/agent.js';
import { getGitStatus, updateClaudeMd, initGitHub } from '../services/git.js';
import { destroyAllSessions, hasSavedSessions, restoreSavedSessions, saveSessionState, updateAgentBinary } from '../services/console.js';
import { getPresetStatus } from '../services/preset.js';
import agentRoutes from '../routes/agent.routes.js';
import githubRoutes from '../routes/github.routes.js';
import gitRoutes from '../routes/git.routes.js';
import sshRoutes from '../routes/ssh.routes.js';
import filesRoutes from '../routes/files.routes.js';
import { startPortScanner, stopPortScanner, getActivePorts } from '../services/ports.js';
import { initPortManager } from '../services/port-manager.js';
import { startMdns, stopMdns, getLanIP } from '../services/mdns.js';
import { ensureDirectories } from '../services/memory.js';
import { initializeIndexer, shutdownIndexer } from '../services/memory-indexer.js';
import { initializeSearch, shutdownSearch } from '../services/memory-search.js';
import consoleRoutes from '../routes/console.routes.js';
import presetRoutes from '../routes/preset.routes.js';
import memoryRoutes from '../routes/memory.routes.js';
import projectRoutes from '../routes/project.routes.js';
import workspaceRoutes from '../routes/workspace.routes.js';
import dashboardRoutes from '../routes/dashboard.routes.js';
import codeckRoutes from '../routes/codeck.routes.js';
import permissionsRoutes from '../routes/permissions.routes.js';
import systemRoutes from '../routes/system.routes.js';
import proactiveAgentsRoutes from '../routes/agents.routes.js';
import { initProactiveAgents, shutdownProactiveAgents } from '../services/proactive-agents.js';
import { initializeEmbeddings, shutdownEmbeddings } from '../services/embeddings.js';
import { cleanupOldSessions } from '../services/session-summarizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.CODECK_PORT || '80', 10);

function logMemoryConfig(): void {
  const heapStats = v8.getHeapStatistics();
  const heapLimitMB = Math.round(heapStats.heap_size_limit / 1024 / 1024);

  // Read container memory limit from cgroup (if available)
  let containerLimitMB: number | null = null;
  try {
    const raw = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (raw !== 'max') {
      containerLimitMB = Math.round(parseInt(raw, 10) / 1024 / 1024);
    }
  } catch {
    // Not in a cgroup-limited container
  }

  if (containerLimitMB) {
    console.log(`[Memory] Container limit: ${containerLimitMB}MB, V8 heap limit: ${heapLimitMB}MB`);
  } else {
    console.log(`[Memory] V8 heap limit: ${heapLimitMB}MB`);
  }
}

export async function startWebServer(): Promise<void> {
  installLogInterceptor();

  const app = express();
  const server = createServer(app);

  // Security headers FIRST — must apply to ALL responses (static + dynamic)
  app.use(helmet({
    // CSP in report-only mode: logs violations to browser console without blocking.
    // This lets us identify issues without breaking the page.
    contentSecurityPolicy: false,
    // Disable HSTS — Codeck runs over plain HTTP in a local/LAN environment
    strictTransportSecurity: false,
    // Disable cross-origin isolation headers — they block CDN resources (Google Fonts)
    // and static assets with crossorigin attribute (Vite output)
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
  }));

  app.use(express.json());

  // Hashed assets (JS/CSS) get long cache; index.html always revalidates
  app.use(express.static(join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (filePath.includes('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));

  // Rate Limiting (in-memory, per-route groups with stale IP cleanup)
  function createRateLimiter(maxRequests: number, windowMs = 60000) {
    const counts = new Map<string, { count: number; resetAt: number }>();

    // Clean up stale entries every 5 minutes
    setInterval(() => {
      const now = Date.now();
      for (const [ip, entry] of counts) {
        if (now > entry.resetAt) counts.delete(ip);
      }
    }, 5 * 60000);

    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const ip = req.ip || 'unknown';
      const now = Date.now();
      const entry = counts.get(ip) || { count: 0, resetAt: now + windowMs };
      if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
      entry.count++;
      counts.set(ip, entry);
      if (entry.count > maxRequests) { res.status(429).json({ error: 'Too many requests' }); return; }
      next();
    };
  }

  // CSRF Defense: Sec-Fetch-Site header validation (blocks cross-site requests even with leaked tokens)
  app.use('/api', (req, res, next) => {
    const fetchSite = req.headers['sec-fetch-site'] as string | undefined;
    if (fetchSite === 'cross-site') {
      console.warn(`[CSRF] Rejected cross-site request: ${req.method} ${req.path}`);
      return res.status(403).json({ error: 'Cross-site requests not allowed' });
    }
    // Allow: same-origin, same-site, none (navigation/bookmarks), or absent (old browsers → fallback to Bearer token)
    next();
  });

  // Stricter limit for auth endpoints (brute-force protection)
  app.use('/api/auth', createRateLimiter(10));
  // General API rate limit
  app.use('/api', createRateLimiter(200));

  // Account lockout (brute-force protection beyond rate limiting)
  const MAX_FAILED_ATTEMPTS = 5;
  const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
  const failedAttempts = new Map<string, { count: number; lockedUntil: number }>();

  function checkLockout(ip: string): { locked: boolean; retryAfter?: number } {
    const entry = failedAttempts.get(ip);
    if (!entry) return { locked: false };
    if (Date.now() < entry.lockedUntil) {
      return { locked: true, retryAfter: Math.ceil((entry.lockedUntil - Date.now()) / 1000) };
    }
    failedAttempts.delete(ip);
    return { locked: false };
  }

  function recordFailedLogin(ip: string): void {
    const entry = failedAttempts.get(ip) || { count: 0, lockedUntil: 0 };
    entry.count++;
    if (entry.count >= MAX_FAILED_ATTEMPTS) {
      entry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
      entry.count = 0;
    }
    failedAttempts.set(ip, entry);
  }

  function clearFailedAttempts(ip: string): void {
    failedAttempts.delete(ip);
  }

  // Auth Endpoints (public, before middleware)
  app.get('/api/auth/status', (_req, res) => {
    const configured = isPasswordConfigured();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ configured });
  });
  app.post('/api/auth/setup', async (req, res) => {
    if (isPasswordConfigured()) { res.status(400).json({ error: 'Password already configured' }); return; }
    const { password } = req.body;
    if (!password || password.length < 8) { res.status(400).json({ error: 'Password must be at least 8 characters' }); return; }
    if (password.length > 256) { res.status(400).json({ error: 'Password must not exceed 256 characters' }); return; }
    res.json(await setupPassword(password));
  });
  app.post('/api/auth/login', async (req, res) => {
    const ip = req.ip || 'unknown';
    const lockout = checkLockout(ip);
    if (lockout.locked) {
      res.status(429).json({ success: false, error: 'Too many failed attempts. Try again later.', retryAfter: lockout.retryAfter });
      return;
    }
    const result = await validatePassword(req.body.password);
    if (result.success) {
      clearFailedAttempts(ip);
      res.json({ success: true, token: result.token });
    } else {
      recordFailedLogin(ip);
      res.status(401).json({ success: false, error: 'Incorrect password' });
    }
  });
  // Auth Middleware (protects all /api/* below)
  app.use('/api', (req, res, next) => {
    if (!isPasswordConfigured()) return next();

    // Localhost bypass for memory API — agent inside container has full access
    if (req.path.startsWith('/memory')) {
      const ip = req.ip || '';
      if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    }

    // Support token via Bearer header or ?token= query param (for download links)
    const token = req.headers.authorization?.replace('Bearer ', '') || (req.query.token as string | undefined);
    if (!token || !validateSession(token)) { res.status(401).json({ error: 'Unauthorized', needsAuth: true }); return; }
    next();
  });

  // Logout (protected — requires active session to prevent unauthenticated session invalidation)
  app.post('/api/auth/logout', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) invalidateSession(token);
    res.json({ success: true });
  });

  // Password change (protected — requires active session)
  app.post('/api/auth/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) { res.status(400).json({ error: 'New password must be at least 8 characters' }); return; }
    if (newPassword.length > 256) { res.status(400).json({ error: 'New password must not exceed 256 characters' }); return; }
    const result = await changePassword(currentPassword, newPassword);
    if (result.success) res.json({ success: true, token: result.token });
    else res.status(401).json({ success: false, error: result.error });
  });

  // Ports (protected — previously public, moved behind auth per AUDIT-14)
  app.get('/api/ports', (_req, res) => {
    res.json(getActivePorts());
  });

  // Status + logs
  app.get('/api/status', (_req, res) => {
    res.json({ claude: getClaudeStatus(), git: getGitStatus(), preset: getPresetStatus(), agent: { name: ACTIVE_AGENT.name, id: ACTIVE_AGENT.id } });
  });
  app.get('/api/logs', (_req, res) => {
    res.json({ logs: getLogBuffer() });
  });

  // Routes (all protected by auth middleware above)
  app.use('/api/claude', agentRoutes);
  app.use('/api/github', githubRoutes);
  app.use('/api/git', gitRoutes);
  app.use('/api/ssh', sshRoutes);
  app.use('/api/files', filesRoutes);
  app.use('/api/console', consoleRoutes);
  app.use('/api/presets', presetRoutes);
  app.use('/api/memory', memoryRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api/workspace', workspaceRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/codeck', codeckRoutes);
  app.use('/api/permissions', permissionsRoutes);
  app.use('/api/system', systemRoutes);
  app.use('/api/agents', proactiveAgentsRoutes);

  // Account endpoint
  app.get('/api/account', (_req, res) => {
    res.json({ authenticated: isClaudeAuthenticated(), account: getAccountInfo() });
  });

  // SPA catch-all — serve index.html for all non-API routes (client-side routing)
  app.get('*', (_req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
  });

  // Centralized error handler — catch-all for unhandled errors in routes (CWE-209)
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Log full error server-side for debugging
    console.error(`[Error] ${req.method} ${req.path}: ${err.message}`);

    // Send sanitized error to client — never expose stack traces or internal paths
    const status = (err as Error & { statusCode?: number }).statusCode || 500;
    const message = status >= 500 ? 'Internal server error' : err.message;
    res.status(status).json({ error: message });
  });

  // WebSocket
  setupWebSocket(server);

  // Graceful shutdown
  function gracefulShutdown(signal: string): void {
    console.log(`[Server] Received signal ${signal}, shutting down...`);
    saveSessionState('shutdown');
    stopTokenRefreshMonitor();
    shutdownProactiveAgents();
    shutdownEmbeddings();
    shutdownSearch();
    shutdownIndexer();
    stopMdns();
    stopPortScanner();
    destroyAllSessions();
    server.close(() => {
      console.log('[Server] Closed cleanly');
      process.exit(0);
    });
    setTimeout(() => {
      console.log('[Server] Forcing exit');
      process.exit(1);
    }, 5000);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  server.listen(PORT, () => {
    const lanIP = getLanIP();
    const isLan = lanIP !== '127.0.0.1' && !lanIP.startsWith('172.');
    const portSuffix = PORT === 80 ? '' : `:${PORT}`;
    console.log(`\n🐳 Codeck running`);
    console.log(`   Local: http://localhost${portSuffix}`);
    if (isLan) {
      console.log(`   LAN:   http://codeck.local${portSuffix}  (${lanIP})`);
    }
    console.log('');
    logMemoryConfig();
    initPortManager();
    initGitHub();
    updateClaudeMd();
    ensureDirectories();

    // Auto-update agent CLI in background (non-blocking)
    setTimeout(() => {
      try {
        const result = updateAgentBinary();
        console.log(`[Startup] Agent CLI updated: ${result.version}`);
      } catch (e) {
        console.log(`[Startup] Agent CLI update skipped: ${(e as Error).message}`);
      }
    }, 0);
    initializeEmbeddings().then(() =>
      initializeIndexer().then(() => initializeSearch())
    );
    startPortScanner();
    startMdns();
    initProactiveAgents(broadcast);
    startTokenRefreshMonitor();

    // Daily session transcript cleanup (remove >30 day old JSONL files)
    // Run once at startup and then every 24 hours
    setTimeout(() => cleanupOldSessions(30).catch(() => {}), 60_000);
    setInterval(() => cleanupOldSessions(30).catch(() => {}), 24 * 60 * 60 * 1000);

    // Auto-restore sessions from previous container lifecycle
    if (hasSavedSessions()) {
      const restoreDelayMs = parseInt(process.env.SESSION_RESTORE_DELAY || '2000', 10);
      setTimeout(() => {
        const restored = restoreSavedSessions();
        // Always broadcast sessions:restored, even if empty.
        // The frontend keeps the "Restoring sessions..." overlay visible until it
        // receives this message. If we only broadcast on restored.length > 0, an empty
        // restore (e.g. all sessions failed) leaves the overlay stuck forever.
        broadcast({ type: 'sessions:restored', data: restored });
      }, restoreDelayMs);
    }
  });
}
