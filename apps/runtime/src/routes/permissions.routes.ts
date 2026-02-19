import { Router } from 'express';
import { getPermissions, setPermissions } from '../services/permissions.js';

const router = Router();

const VALID_PERMISSIONS = ['Read', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch'] as const;

router.get('/', (_req, res) => {
  res.json(getPermissions());
});

router.post('/', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: 'Request body must be an object' });
    return;
  }

  // Only allow known permission keys with boolean values
  const validated: Record<string, boolean> = {};
  for (const key of Object.keys(body)) {
    if (!(VALID_PERMISSIONS as readonly string[]).includes(key)) {
      res.status(400).json({ error: `Unknown permission: ${key}` });
      return;
    }
    if (typeof body[key] !== 'boolean') {
      res.status(400).json({ error: `Permission ${key} must be a boolean` });
      return;
    }
    validated[key] = body[key];
  }

  const updated = setPermissions(validated);
  res.json(updated);
});

export default router;
