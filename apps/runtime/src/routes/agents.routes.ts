import { Router } from 'express';
import { resolve } from 'path';
import {
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  deleteAgent,
  pauseAgent,
  resumeAgent,
  triggerAgent,
  getAgentOutput,
  getAgentLogs,
  getAgentExecutions,
  lintAgentObjective,
} from '../services/proactive-agents.js';
import { sanitizeSecrets } from '../services/session-writer.js';

const router = Router();

const WORKSPACE = process.env.WORKSPACE || '/workspace';

function isValidCwd(cwd: string): boolean {
  if (typeof cwd !== 'string') return false;
  const resolved = resolve(WORKSPACE, cwd);
  return resolved === WORKSPACE || resolved.startsWith(WORKSPACE + '/');
}

// Strip internal file paths from error messages to avoid leaking directory structure (CWE-209)
function sanitizeErrorMessage(msg: string): string {
  return msg.replace(/:\s*\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();
}

// Lint agent objective for suspicious patterns
router.post('/lint', (req, res) => {
  const { objective } = req.body || {};
  if (!objective || typeof objective !== 'string') {
    res.json({ warnings: [] });
    return;
  }
  res.json({ warnings: lintAgentObjective(objective) });
});

// Create agent
router.post('/', (req, res) => {
  try {
    const { name, objective, schedule, cwd, model, timeoutMs, maxRetries } = req.body || {};
    if (cwd && !isValidCwd(cwd)) {
      res.status(400).json({ error: `Working directory must be within ${WORKSPACE}` });
      return;
    }
    const warnings = objective ? lintAgentObjective(objective) : [];
    const agent = createAgent({ name, objective, schedule, cwd, model, timeoutMs, maxRetries });
    res.json({ ...agent, lintWarnings: warnings.length > 0 ? warnings : undefined });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'Failed to create agent';
    console.log(`[Agents] Agent creation failed: ${detail}`);
    res.status(400).json({ error: sanitizeErrorMessage(detail) });
  }
});

// List all agents
router.get('/', (_req, res) => {
  res.json({ agents: listAgents() });
});

// Get agent detail
router.get('/:id', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  res.json(agent);
});

// Update agent config
router.put('/:id', (req, res) => {
  try {
    const body = req.body || {};
    if (body.cwd && !isValidCwd(body.cwd)) {
      res.status(400).json({ error: `Working directory must be within ${WORKSPACE}` });
      return;
    }
    const agent = updateAgent(req.params.id, body);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    const warnings = body.objective ? lintAgentObjective(body.objective) : [];
    res.json({ ...agent, lintWarnings: warnings.length > 0 ? warnings : undefined });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'Failed to update agent';
    console.log(`[Agents] Agent update failed: ${detail}`);
    res.status(400).json({ error: sanitizeErrorMessage(detail) });
  }
});

// Pause agent
router.post('/:id/pause', (req, res) => {
  const agent = pauseAgent(req.params.id);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  res.json(agent);
});

// Resume agent
router.post('/:id/resume', (req, res) => {
  const agent = resumeAgent(req.params.id);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  res.json(agent);
});

// Manual trigger
router.post('/:id/execute', (req, res) => {
  try {
    const result = triggerAgent(req.params.id);
    if (!result) { res.status(404).json({ error: 'Agent not found' }); return; }
    res.json(result);
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'Failed to trigger agent';
    console.log(`[Agents] Agent trigger failed: ${detail}`);
    res.status(400).json({ error: sanitizeErrorMessage(detail) });
  }
});

// Delete agent
router.delete('/:id', (req, res) => {
  const deleted = deleteAgent(req.params.id);
  if (!deleted) { res.status(404).json({ error: 'Agent not found' }); return; }
  res.json({ success: true });
});

// Get live output buffer (current execution, in-memory).
// ?sanitize=true applies secret sanitization (buffer is unsanitized for live debugging by default).
router.get('/:id/output', (req, res) => {
  let output = getAgentOutput(req.params.id);
  if (output === null) { res.status(404).json({ error: 'Agent not found or no output' }); return; }
  if (req.query.sanitize === 'true') output = sanitizeSecrets(output);
  res.type('text/plain').send(output);
});

// Get execution log (text/plain). ?ts=<epoch_ms> for specific execution, otherwise latest.
router.get('/:id/logs', (req, res) => {
  const ts = req.query.ts as string | undefined;
  const logs = getAgentLogs(req.params.id, ts);
  if (logs === null) { res.status(404).json({ error: 'No logs found' }); return; }
  res.type('text/plain').send(logs);
});

// Get execution history
router.get('/:id/executions', (req, res) => {
  const parsed = parseInt(req.query.limit as string, 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1000) : 20;
  const executions = getAgentExecutions(req.params.id, limit);
  res.json({ executions });
});

export default router;
