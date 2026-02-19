import { Router } from 'express';
import {
  getDurableMemory, writeDurableMemory, appendToDurableMemory,
  getDailyEntry, appendToDaily, listDailyEntries,
  createDecision, listDecisions, getDecision,
  listProjects, getProjectMemory,
  listPathScopes, getPathMemory, writePathMemory, resolvePathId, getPathMapping,
  promote, flush, getFlushState,
  getSummary, getDecisionsLegacy,
  assembleContext, getMemoryStatus, getMemoryStats, listMemoryFiles,
  sanitizePathId,
  type PromoteRequest,
} from '../services/memory.js';
import { listSessionFiles, readSessionTranscript, getSessionSummary } from '../services/session-writer.js';
import { search, isSearchAvailable, hybridSearch } from '../services/memory-search.js';
import { indexAll, getIndexStats, isIndexerAvailable, isVecAvailable } from '../services/memory-indexer.js';

const router = Router();

const MAX_CONTENT_LENGTH = 51200; // 50KB for content/entry fields
const MAX_SHORT_LENGTH = 200;     // short fields: title, section, project, etc.

/** Validate optional pathId from untrusted input. Returns sanitized value, undefined, or null (invalid → 400 sent). */
function validPathId(raw: string | undefined, res: import('express').Response): string | undefined | null {
  if (!raw) return undefined;
  const clean = sanitizePathId(raw);
  if (!clean) { res.status(400).json({ error: 'Invalid pathId: must be 12-char hex' }); return null; }
  return clean;
}

/** Validate a required string field. Returns the string or null (400 already sent). */
function requireString(value: unknown, name: string, res: import('express').Response, maxLen = MAX_CONTENT_LENGTH): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    res.status(400).json({ error: `${name} must be a non-empty string` });
    return null;
  }
  if (value.length > maxLen) {
    res.status(400).json({ error: `${name} exceeds max length (${maxLen})` });
    return null;
  }
  return value;
}

/** Validate an optional string field. Returns the string, undefined, or null (400 already sent). */
function optionalString(value: unknown, name: string, res: import('express').Response, maxLen = MAX_SHORT_LENGTH): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    res.status(400).json({ error: `${name} must be a string` });
    return null;
  }
  if (value.length > maxLen) {
    res.status(400).json({ error: `${name} exceeds max length (${maxLen})` });
    return null;
  }
  return value;
}

/** Validate an optional string array. Returns the array, undefined, or null (400 already sent). */
function optionalStringArray(value: unknown, name: string, res: import('express').Response): string[] | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
    res.status(400).json({ error: `${name} must be an array of strings` });
    return null;
  }
  return value as string[];
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Validate optional date query parameter (YYYY-MM-DD). Returns the date, undefined, or null (400 already sent). */
function validDate(raw: string | undefined, res: import('express').Response): string | undefined | null {
  if (!raw) return undefined;
  if (!DATE_REGEX.test(raw)) {
    res.status(400).json({ error: 'Invalid date format (expected YYYY-MM-DD)' });
    return null;
  }
  return raw;
}

// ── Backward-compat endpoints ──

router.get('/summary', (_req, res) => {
  res.json(getSummary());
});

router.get('/decisions', (_req, res) => {
  res.json(getDecisionsLegacy());
});

// Legacy project endpoints (delegates to path system)
router.get('/projects', (_req, res) => {
  res.json({ projects: listProjects() });
});

router.get('/projects/:name', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_\-]/g, '');
  const result = getProjectMemory(name);
  if (!result.exists) {
    res.status(404).json({ error: 'Project memory not found' });
    return;
  }
  res.json({ name, content: result.content });
});

// ── Status ──

router.get('/status', (_req, res) => {
  res.json(getMemoryStatus());
});

router.get('/stats', (_req, res) => {
  res.json(getMemoryStats());
});

router.get('/files', (_req, res) => {
  res.json({ files: listMemoryFiles() });
});

// ── Durable Memory (MEMORY.md) ──

router.get('/durable', (req, res) => {
  const pathId = validPathId(req.query.pathId as string | undefined, res);
  if (pathId === null) return;
  res.json(getDurableMemory(pathId));
});

router.put('/durable', (req, res) => {
  const pathId = validPathId(req.body.pathId, res);
  if (pathId === null) return;
  const content = requireString(req.body.content, 'content', res, MAX_CONTENT_LENGTH);
  if (content === null) return;
  writeDurableMemory(content, pathId);
  res.json({ success: true });
});

router.post('/durable/append', (req, res) => {
  const pathId = validPathId(req.body.pathId, res);
  if (pathId === null) return;
  const section = requireString(req.body.section, 'section', res, MAX_SHORT_LENGTH);
  if (section === null) return;
  const entry = requireString(req.body.entry, 'entry', res);
  if (entry === null) return;
  appendToDurableMemory(section, entry, pathId);
  res.json({ success: true });
});

// ── Daily ──

router.get('/daily', (req, res) => {
  const date = validDate(req.query.date as string | undefined, res);
  if (date === null) return;
  const pathId = validPathId(req.query.pathId as string | undefined, res);
  if (pathId === null) return;
  res.json(getDailyEntry(date, pathId));
});

router.get('/daily/list', (req, res) => {
  const pathId = validPathId(req.query.pathId as string | undefined, res);
  if (pathId === null) return;
  res.json({ entries: listDailyEntries(pathId) });
});

router.post('/daily', (req, res) => {
  const pathId = validPathId(req.body.pathId, res);
  if (pathId === null) return;
  const entry = requireString(req.body.entry, 'entry', res);
  if (entry === null) return;
  const project = optionalString(req.body.project, 'project', res);
  if (project === null) return;
  const tags = optionalStringArray(req.body.tags, 'tags', res);
  if (tags === null) return;
  const result = appendToDaily(entry, project, tags, pathId);
  res.json({ success: true, ...result });
});

// Backward-compat: /journal → /daily
router.get('/journal', (req, res) => {
  const date = validDate(req.query.date as string | undefined, res);
  if (date === null) return;
  res.json(getDailyEntry(date));
});

router.get('/journal/list', (_req, res) => {
  res.json({ journals: listDailyEntries() });
});

router.post('/journal', (req, res) => {
  const entry = requireString(req.body.entry, 'entry', res);
  if (entry === null) return;
  const project = optionalString(req.body.project, 'project', res);
  if (project === null) return;
  const tags = optionalStringArray(req.body.tags, 'tags', res);
  if (tags === null) return;
  const result = appendToDaily(entry, project, tags);
  res.json({ success: true, ...result });
});

// ── Decisions (ADR) ──

router.post('/decisions/create', (req, res) => {
  const pathId = validPathId(req.body.pathId, res);
  if (pathId === null) return;
  const title = requireString(req.body.title, 'title', res, MAX_SHORT_LENGTH);
  if (title === null) return;
  const context = requireString(req.body.context, 'context', res);
  if (context === null) return;
  const decision = requireString(req.body.decision, 'decision', res);
  if (decision === null) return;
  const consequences = requireString(req.body.consequences, 'consequences', res);
  if (consequences === null) return;
  const project = optionalString(req.body.project, 'project', res);
  if (project === null) return;
  const result = createDecision(title, context, decision, consequences, project, pathId);
  res.json({ success: true, ...result });
});

router.get('/decisions/list', (req, res) => {
  const pathId = validPathId(req.query.pathId as string | undefined, res);
  if (pathId === null) return;
  res.json({ decisions: listDecisions(pathId) });
});

router.get('/decisions/:filename', (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  const result = getDecision(filename);
  if (!result.exists) {
    res.status(404).json({ error: 'Decision not found' });
    return;
  }
  res.json(result);
});

// ── Path scopes ──

router.get('/paths', (_req, res) => {
  res.json({ paths: listPathScopes() });
});

router.get('/paths/:pathId', (req, res) => {
  const pathId = validPathId(req.params.pathId, res);
  if (!pathId) return;
  const mapping = getPathMapping(pathId);
  if (!mapping) {
    res.status(404).json({ error: 'Path scope not found' });
    return;
  }
  const memory = getPathMemory(pathId);
  res.json({ ...mapping, ...memory });
});

router.put('/paths/:pathId', (req, res) => {
  const pathId = validPathId(req.params.pathId, res);
  if (!pathId) return;
  const content = requireString(req.body.content, 'content', res, MAX_CONTENT_LENGTH);
  if (content === null) return;
  writePathMemory(pathId, content);
  res.json({ success: true });
});

router.post('/paths/resolve', (req, res) => {
  const canonicalPath = requireString(req.body.canonicalPath, 'canonicalPath', res, 1024);
  if (canonicalPath === null) return;
  const pathId = resolvePathId(canonicalPath);
  const mapping = getPathMapping(pathId);
  res.json({ pathId, mapping });
});

// ── Promote ──

router.post('/promote', (req, res) => {
  const { target } = req.body;

  // Validate content (required unless target is 'adr')
  let content: string;
  if (target !== 'adr') {
    const c = requireString(req.body.content, 'content', res);
    if (c === null) return;
    content = c;
  } else {
    content = typeof req.body.content === 'string' ? req.body.content : '';
  }

  const sourceRef = optionalString(req.body.sourceRef, 'sourceRef', res);
  if (sourceRef === null) return;
  const targetScope = optionalString(req.body.targetScope, 'targetScope', res);
  if (targetScope === null) return;
  const section = optionalString(req.body.section, 'section', res);
  if (section === null) return;
  const tags = optionalStringArray(req.body.tags, 'tags', res);
  if (tags === null) return;
  const title = optionalString(req.body.title, 'title', res);
  if (title === null) return;
  const context = optionalString(req.body.context, 'context', res, MAX_CONTENT_LENGTH);
  if (context === null) return;
  const decision = optionalString(req.body.decision, 'decision', res, MAX_CONTENT_LENGTH);
  if (decision === null) return;
  const consequences = optionalString(req.body.consequences, 'consequences', res, MAX_CONTENT_LENGTH);
  if (consequences === null) return;

  // Resolve scope: 'global', or pathId (from body.pathId or targetScope itself)
  const rawPathId = req.body.pathId as string | undefined;
  const pathId = rawPathId ? validPathId(rawPathId, res) : null;
  if (rawPathId && pathId === null) return;  // invalid pathId → 400 already sent
  const resolvedScope = (targetScope === 'path' && pathId) ? pathId : (targetScope || 'global');

  const promoteReq: PromoteRequest = {
    content,
    sourceRef,
    targetScope: resolvedScope,
    target: target || 'durable',
    section,
    tags,
    title,
    context,
    decision,
    consequences,
  };
  const result = promote(promoteReq);
  res.json(result);
});

// ── Flush ──

router.post('/flush', (req, res) => {
  const rawScope = req.body.scope as string | undefined;
  // scope must be 'global' or a valid 12-char hex pathId
  let scope = 'global';
  if (rawScope && rawScope !== 'global') {
    const cleaned = sanitizePathId(rawScope);
    if (!cleaned) {
      res.status(400).json({ error: 'Invalid scope: must be "global" or 12-char hex pathId' });
      return;
    }
    scope = cleaned;
  }
  const content = requireString(req.body.content, 'content', res);
  if (content === null) return;
  const project = optionalString(req.body.project, 'project', res);
  if (project === null) return;
  const tags = optionalStringArray(req.body.tags, 'tags', res);
  if (tags === null) return;
  const result = flush(content, scope, project, tags);
  if (!result.success) {
    res.status(429).json(result);
    return;
  }
  res.json(result);
});

router.get('/flush/state', (_req, res) => {
  res.json(getFlushState());
});

// ── Sessions ──

router.get('/sessions', async (_req, res) => {
  res.json({ sessions: await listSessionFiles() });
});

router.get('/sessions/:id', async (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9_\-]/g, '');
  const result = await readSessionTranscript(id);
  if (!result.exists) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(result);
});

router.get('/sessions/:id/summary', async (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9_\-]/g, '');
  const result = await getSessionSummary(id);
  if (!result.exists) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(result.summary);
});

// ── Search ──

router.get('/search', (req, res) => {
  if (!isSearchAvailable()) {
    res.json({ results: [], available: false });
    return;
  }
  const q = req.query.q as string;

  if (q && q.length > 1000) {
    res.status(400).json({ error: 'Query exceeds maximum length (1000 characters)' });
    return;
  }

  const scope = req.query.scope ? (req.query.scope as string).split(',') : undefined;
  const limit = req.query.limit ? Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 100) : undefined;
  const project = req.query.project as string | undefined;
  const pathId = validPathId(req.query.pathId as string | undefined, res);
  if (pathId === null) return;
  const dateFrom = validDate(req.query.dateFrom as string | undefined, res);
  if (dateFrom === null) return;
  const dateTo = validDate(req.query.dateTo as string | undefined, res);
  if (dateTo === null) return;

  const mode = req.query.mode as string | undefined;
  const useHybrid = mode === 'hybrid' || (!mode && isVecAvailable());
  const searchOpts = { query: q || '', scope, project, pathId, dateFrom, dateTo, limit };

  if (useHybrid) {
    hybridSearch(searchOpts).then(results => {
      res.json({ results, available: true, mode: 'hybrid' });
    }).catch(() => {
      // Fallback to BM25 on hybrid failure
      const results = search(searchOpts);
      res.json({ results, available: true, mode: 'bm25' });
    });
    return;
  }

  const results = search(searchOpts);
  res.json({ results, available: true, mode: 'bm25' });
});

router.get('/search/stats', (_req, res) => {
  if (!isIndexerAvailable()) {
    res.json({ available: false });
    return;
  }
  res.json(getIndexStats());
});

router.post('/search/reindex', (_req, res) => {
  if (!isIndexerAvailable()) {
    res.status(503).json({ error: 'Indexer not available' });
    return;
  }
  const result = indexAll();
  if (!result.success) {
    res.status(409).json({ error: result.reason });
    return;
  }
  res.json({ success: true, stats: getIndexStats() });
});

// ── Context assembly ──

router.get('/context', (req, res) => {
  const pathId = validPathId(req.query.pathId as string | undefined, res);
  if (pathId === null) return;
  // Legacy compat: accept project as pathId
  const project = req.query.project as string | undefined;
  res.json({ context: assembleContext(pathId || project) });
});

export default router;
