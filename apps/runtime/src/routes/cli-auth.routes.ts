/**
 * CLI-based OAuth routes for third-party service authentication.
 * Provides start/status/cancel endpoints for device flow auth.
 */
import { Router } from 'express';
import { startCLIAuth, getAuthState, cancelCLIAuth, getSupportedCLIAuthServices, isValidService, isCLIAuthenticated } from '../services/cli-auth.js';
import { broadcastStatus } from '../web/websocket.js';

const router = Router();

// GET /supported — list services that support CLI auth
router.get('/supported', (_req, res) => {
  res.json({ services: getSupportedCLIAuthServices() });
});

// Validate service param against allowlist for all mutating routes
router.param('service', (req, res, next, service) => {
  if (!isValidService(service)) {
    res.status(400).json({ error: 'Unsupported service' });
    return;
  }
  next();
});

// POST /:service/login — start CLI device flow
router.post('/:service/login', (req, res) => {
  const state = startCLIAuth(req.params.service, () => broadcastStatus());
  res.json(state);
});

// GET /:service/status — poll auth status
router.get('/:service/status', (req, res) => {
  res.json(getAuthState(req.params.service));
});

// POST /:service/cancel — cancel in-progress login
router.post('/:service/cancel', (req, res) => {
  cancelCLIAuth(req.params.service);
  res.json({ cancelled: true });
});

// GET /:service/authenticated — check if CLI is logged in (vercel whoami, etc.)
// Rate-limited: max 3 req/min per IP (spawns subprocess, avoid DoS)
const authCheckTimestamps = new Map<string, number>();
router.get('/:service/authenticated', async (req, res) => {
  const key = `${req.ip}:${req.params.service}`;
  const last = authCheckTimestamps.get(key) || 0;
  if (Date.now() - last < 20_000) { // 20s cooldown per service per IP
    res.status(429).json({ error: 'Rate limited — try again in a few seconds' });
    return;
  }
  authCheckTimestamps.set(key, Date.now());
  const result = await isCLIAuthenticated(req.params.service);
  res.json(result);
});

export default router;
