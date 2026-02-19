import { Router } from 'express';
import { hasSSHKey, generateSSHKey, getSSHPublicKey, testSSHConnection, deleteSSHKey } from '../services/git.js';
import { broadcastStatus } from '../web/websocket.js';

const router = Router();

router.get('/status', (_req, res) => {
  res.json({ hasKey: hasSSHKey() });
});

router.post('/generate', (req, res) => {
  const force = req.body?.force === true;
  const result = generateSSHKey(force);
  broadcastStatus();
  res.json(result);
});

router.get('/public-key', (_req, res) => {
  const publicKey = getSSHPublicKey();
  if (publicKey) res.json({ success: true, publicKey });
  else res.status(500).json({ success: false, error: 'Could not get public key' });
});

router.get('/test', (_req, res) => {
  res.json({ success: true, authenticated: testSSHConnection() });
});

router.delete('/key', (_req, res) => {
  const result = deleteSSHKey();
  broadcastStatus();
  if (result.success) res.json(result);
  else res.status(500).json(result);
});

export default router;
