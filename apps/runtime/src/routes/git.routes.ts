import { Router } from 'express';
import { cloneRepository } from '../services/git.js';
import { broadcastStatus } from '../web/websocket.js';

const router = Router();

// Clone repository
router.post('/clone', async (req, res) => {
  const { url, token, useSSH } = req.body;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'URL required (string)' });
    return;
  }
  if (url.length > 2048) {
    res.status(400).json({ error: 'URL too long (max 2048 characters)' });
    return;
  }
  if (token !== undefined && (typeof token !== 'string' || token.length > 500)) {
    res.status(400).json({ error: 'Invalid token format' });
    return;
  }

  const result = await cloneRepository(url, token, useSSH);
  broadcastStatus();
  res.json(result);
});

export default router;
