import { Router } from 'express';
import { isClaudeAuthenticated } from '../services/auth-anthropic.js';
import {
  createConsoleSession,
  createShellSession,
  getSessionCount,
  MAX_SESSIONS,
  resizeSession,
  destroySession,
  renameSession,
  listSessions,
  hasResumableConversations,
} from '../services/console.js';
import { broadcastStatus } from '../web/websocket.js';

const router = Router();

// Create console session (multi-session, max 5)
router.post('/create', (req, res) => {
  if (!isClaudeAuthenticated()) {
    res.status(400).json({ error: 'Claude is not authenticated' });
    return;
  }

  if (getSessionCount() >= MAX_SESSIONS) {
    res.status(400).json({ error: `Maximum ${MAX_SESSIONS} simultaneous sessions` });
    return;
  }

  const { cwd, resume } = req.body || {};
  try {
    const session = createConsoleSession({ cwd: cwd || undefined, resume });
    console.log(`[Console] Session created: ${session.id} (cwd: ${session.cwd}, resume: ${!!resume})`);
    broadcastStatus();
    res.json({ sessionId: session.id, cwd: session.cwd, name: session.name });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'Failed to create session';
    console.log(`[Console] Session creation failed: ${detail}`);
    res.status(400).json({ error: 'Failed to create session' });
  }
});

// Create shell session — does not require Claude OAuth (shells don't use Claude),
// but is still protected by password auth middleware in server.ts
router.post('/create-shell', (req, res) => {
  if (getSessionCount() >= MAX_SESSIONS) {
    res.status(400).json({ error: `Maximum ${MAX_SESSIONS} simultaneous sessions` });
    return;
  }

  const { cwd } = req.body || {};
  try {
    const session = createShellSession(cwd || undefined);
    console.log(`[Console] Shell session created: ${session.id} (cwd: ${session.cwd})`);
    broadcastStatus();
    res.json({ sessionId: session.id, cwd: session.cwd, name: session.name });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'Failed to create shell session';
    console.log(`[Console] Shell session creation failed: ${detail}`);
    res.status(400).json({ error: 'Failed to create shell session' });
  }
});

// List active console sessions
router.get('/sessions', (_req, res) => {
  res.json({ sessions: listSessions() });
});

// Check if a directory has resumable conversations
router.get('/has-conversations', (req, res) => {
  const cwd = req.query.cwd as string;
  if (!cwd) {
    res.status(400).json({ error: 'cwd query param required' });
    return;
  }
  res.json({ hasConversations: hasResumableConversations(cwd) });
});

// Rename console session
router.post('/rename', (req, res) => {
  const { sessionId, name } = req.body;
  if (!sessionId || typeof name !== 'string') {
    res.status(400).json({ error: 'sessionId and name required' });
    return;
  }
  // Strip HTML tags to prevent stored XSS when displayed in frontend
  const sanitized = name.replace(/<[^>]*>/g, '').trim();
  if (!sanitized || sanitized.length > 200) {
    res.status(400).json({ error: 'Name must be 1-200 characters (no HTML)' });
    return;
  }
  const ok = renameSession(sessionId, sanitized);
  if (!ok) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ success: true });
});

// Resize console
router.post('/resize', (req, res) => {
  const { sessionId, cols, rows } = req.body;
  if (!sessionId || typeof cols !== 'number' || typeof rows !== 'number') {
    res.status(400).json({ error: 'sessionId, cols (number), rows (number) required' });
    return;
  }
  if (cols < 1 || cols > 500 || rows < 1 || rows > 200) {
    res.status(400).json({ error: 'cols must be 1-500, rows must be 1-200' });
    return;
  }
  resizeSession(sessionId, cols, rows);
  res.json({ success: true });
});

// Destroy console session
router.post('/destroy', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId required' });
    return;
  }
  destroySession(sessionId);
  console.log(`[Console] Session destroyed: ${sessionId}`);
  broadcastStatus();
  res.json({ success: true });
});

export default router;
