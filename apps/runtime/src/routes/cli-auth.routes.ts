/**
 * CLI-based OAuth routes for third-party service authentication.
 * Provides start/status/cancel endpoints for device flow auth.
 */
import { Router } from 'express';
import { startCLIAuth, getAuthState, cancelCLIAuth, getSupportedCLIAuthServices, isValidService } from '../services/cli-auth.js';
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

export default router;
