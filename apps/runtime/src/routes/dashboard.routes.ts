import { Router } from 'express';
import { getContainerResources } from '../services/resources.js';
import { getClaudeUsage } from '../services/agent-usage.js';

const router = Router();

// Combined dashboard endpoint — container resources + Claude usage
router.get('/', async (_req, res) => {
  const [resources, claude] = await Promise.all([
    Promise.resolve(getContainerResources()),
    getClaudeUsage(),
  ]);

  res.json({ resources, claude });
});

export default router;
