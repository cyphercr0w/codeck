import { Router } from 'express';
import { getPermissions, setPermissions, getMcpPermissions, setMcpPermission, getDenyRules } from '../services/permissions.js';

const router = Router();

const VALID_PERMISSIONS = ['Read', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch'] as const;

// Basic tool permissions
router.get('/', (_req, res) => {
  res.json(getPermissions());
});

router.post('/', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: 'Request body must be an object' });
    return;
  }

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

// MCP server permissions
router.get('/mcp', (_req, res) => {
  res.json({ servers: getMcpPermissions() });
});

router.post('/mcp', (req, res) => {
  const { name, allowed } = req.body || {};
  if (typeof name !== 'string' || !name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (typeof allowed !== 'boolean') {
    res.status(400).json({ error: 'allowed must be a boolean' });
    return;
  }
  const updated = setMcpPermission(name, allowed);
  res.json({ servers: updated });
});

// Deny rules (read-only for now)
router.get('/deny', (_req, res) => {
  res.json({ rules: getDenyRules() });
});

// Full permission state (combined view)
router.get('/all', (_req, res) => {
  res.json({
    basic: getPermissions(),
    mcp: getMcpPermissions(),
    deny: getDenyRules(),
  });
});

export default router;
