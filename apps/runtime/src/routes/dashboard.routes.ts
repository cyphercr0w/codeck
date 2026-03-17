import { Router } from 'express';
import { getContainerResources } from '../services/resources.js';
import { getClaudeUsage } from '../services/agent-usage.js';
import { getMemoryStats } from '../services/memory-stats.js';

const router = Router();

// Combined dashboard endpoint — container resources + Claude usage
router.get('/', async (_req, res) => {
  const [resources, claude] = await Promise.all([
    Promise.resolve(getContainerResources()),
    getClaudeUsage(),
  ]);

  res.json({ resources, claude });
});

// Memory stats endpoint — agent memory visibility
router.get('/memory-stats', async (_req, res) => {
  try {
    const stats = await getMemoryStats();
    res.json(stats);
  } catch (e) {
    console.error('[dashboard] memory-stats error:', (e as Error).message);
    res.status(500).json({ error: 'Failed to load memory stats' });
  }
});

export default router;
