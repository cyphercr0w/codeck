import { Router } from 'express';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, basename } from 'path';
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
import { broadcast } from '../web/logger.js';

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

  // Guard: respond within 10s no matter what — prevents daemon proxy 504 timeout.
  let responded = false;
  const timeout = setTimeout(() => {
    if (!responded) {
      responded = true;
      console.error(`[Console] Shell creation timed out after 10s`);
      res.status(500).json({ error: 'Shell creation timed out — check server logs' });
    }
  }, 10000);

  try {
    const session = createShellSession(cwd || undefined);
    clearTimeout(timeout);
    if (responded) return; // timeout already fired
    responded = true;
    console.log(`[Console] Shell session created: ${session.id} (cwd: ${session.cwd})`);
    broadcastStatus();
    res.json({ sessionId: session.id, cwd: session.cwd, name: session.name });
  } catch (e) {
    clearTimeout(timeout);
    if (responded) return;
    responded = true;
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
router.get('/has-conversations', async (req, res) => {
  const cwd = req.query.cwd as string;
  if (!cwd) {
    res.status(400).json({ error: 'cwd query param required' });
    return;
  }
  res.json({ hasConversations: await hasResumableConversations(cwd) });
});

// List recent conversations across all projects (for resume UI)
router.get('/recent-conversations', (_req, res) => {
  try {
    const home = process.env.HOME || '/root';
    const projectsDir = `${home}/.claude/projects`;
    if (!existsSync(projectsDir)) { res.json({ conversations: [] }); return; }

    const convos: Array<{ id: string; title: string; cwd: string; mtime: number }> = [];

    for (const projectDir of readdirSync(projectsDir)) {
      const fullDir = join(projectsDir, projectDir);
      if (!statSync(fullDir).isDirectory()) continue;

      for (const file of readdirSync(fullDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const convId = basename(file, '.jsonl');
        const filePath = join(fullDir, file);
        const mtime = statSync(filePath).mtimeMs;

        let title = '';
        let cwd = '';
        try {
          const content = readFileSync(filePath, 'utf-8');
          for (const line of content.split('\n').slice(0, 30)) {
            if (!line.trim()) continue;
            const d = JSON.parse(line);
            if (d.type === 'user' && !title) {
              cwd = d.cwd || '';
              const msg = d.message;
              if (msg && typeof msg === 'object') {
                const c = msg.content;
                if (Array.isArray(c)) {
                  for (const block of c) {
                    if (block?.type === 'text' && block.text) {
                      title = block.text.replace(/<[^>]*>/g, '').trim().slice(0, 80);
                      break;
                    }
                  }
                } else if (typeof c === 'string') {
                  title = c.replace(/<[^>]*>/g, '').trim().slice(0, 80);
                }
              }
              if (title) break;
            }
          }
        } catch { /* non-fatal */ }

        if (title && cwd) {
          convos.push({ id: convId, title, cwd, mtime });
        }
      }
    }

    convos.sort((a, b) => b.mtime - a.mtime);
    res.json({ conversations: convos.slice(0, 5) });
  } catch (e) {
    console.warn('[Console] Failed to list recent conversations:', (e as Error).message);
    res.json({ conversations: [] });
  }
});

// Resume a specific conversation by ID
router.post('/resume', (req, res) => {
  if (!isClaudeAuthenticated()) {
    res.status(400).json({ error: 'Claude is not authenticated' });
    return;
  }
  if (getSessionCount() >= MAX_SESSIONS) {
    res.status(400).json({ error: `Maximum ${MAX_SESSIONS} simultaneous sessions` });
    return;
  }

  const { conversationId, cwd } = req.body || {};
  if (!conversationId || typeof conversationId !== 'string') {
    res.status(400).json({ error: 'conversationId required' });
    return;
  }
  // Validate UUID format to prevent CLI flag injection
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(conversationId)) {
    res.status(400).json({ error: 'Invalid conversationId format' });
    return;
  }

  try {
    const session = createConsoleSession({ cwd: cwd || undefined, resume: true, conversationId });
    broadcastStatus();
    res.json({ sessionId: session.id, cwd: session.cwd, name: session.name });
  } catch (e) {
    res.status(400).json({ error: 'Failed to resume conversation' });
  }
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

// Context usage — receives data from statusline.sh and broadcasts to web clients
let contextData: { contextPercent: number; contextTokens: number; contextWindow: number; model: string; updatedAt: number } | null = null;

router.post('/context', (req, res) => {
  const { contextPercent, contextTokens, contextWindow, model } = req.body;
  contextData = {
    contextPercent: contextPercent || 0,
    contextTokens: contextTokens || 0,
    contextWindow: contextWindow || 0,
    model: model || '',
    updatedAt: Date.now(),
  };
  broadcast({ type: 'context', data: contextData });
  res.json({ ok: true });
});

router.get('/context', (_req, res) => {
  res.json(contextData || { contextPercent: 0, contextTokens: 0, contextWindow: 0, model: '', updatedAt: 0 });
});

export default router;
