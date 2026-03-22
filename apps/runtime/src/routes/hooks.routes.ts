import { Router } from 'express';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const router = Router();

const SETTINGS_PATH = join(process.env.HOME || '/root', '.claude', 'settings.json');

type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop' | 'PostCompact';

const VALID_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse', 'Stop', 'PostCompact'] as const;

interface HookEntry {
  type: string;
  command: string;
}

interface HookMatcher {
  matcher: string;
  hooks: HookEntry[];
}

interface SettingsJson {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

async function readSettings(): Promise<SettingsJson> {
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as SettingsJson;
    }
  } catch { /* file missing or invalid */ }
  return {};
}

async function writeSettings(data: SettingsJson): Promise<void> {
  await writeFile(SETTINGS_PATH, JSON.stringify(data, null, 2));
}

// GET / — List all hooks
router.get('/', async (_req, res) => {
  try {
    const settings = await readSettings();
    res.json({ hooks: settings.hooks || {} });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// POST / — Add a hook entry
router.post('/', async (req, res) => {
  try {
    const { event, matcher, command } = req.body;

    if (!event || !(VALID_EVENTS as readonly string[]).includes(event)) {
      res.status(400).json({ success: false, error: `event must be one of: ${VALID_EVENTS.join(', ')}` });
      return;
    }
    if (typeof matcher !== 'string') {
      res.status(400).json({ success: false, error: 'matcher must be a string' });
      return;
    }
    if (!command || typeof command !== 'string') {
      res.status(400).json({ success: false, error: 'command is required' });
      return;
    }

    const settings = await readSettings();
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks[event]) settings.hooks[event] = [];

    // Check if a matcher group already exists for this matcher
    const existing = settings.hooks[event].find((m: HookMatcher) => m.matcher === matcher);
    if (existing) {
      existing.hooks.push({ type: 'command', command });
    } else {
      settings.hooks[event].push({
        matcher,
        hooks: [{ type: 'command', command }],
      });
    }

    await writeSettings(settings);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// DELETE / — Remove a hook by event and index
router.delete('/', async (req, res) => {
  try {
    const { event, index } = req.body;

    if (!event || !(VALID_EVENTS as readonly string[]).includes(event)) {
      res.status(400).json({ success: false, error: `event must be one of: ${VALID_EVENTS.join(', ')}` });
      return;
    }
    if (typeof index !== 'number' || index < 0) {
      res.status(400).json({ success: false, error: 'index must be a non-negative number' });
      return;
    }

    const settings = await readSettings();
    const eventHooks = settings.hooks?.[event];

    if (!eventHooks || index >= eventHooks.length) {
      res.status(404).json({ success: false, error: `Hook at index ${index} not found for event '${event}'` });
      return;
    }

    eventHooks.splice(index, 1);

    // Clean up empty arrays
    if (eventHooks.length === 0 && settings.hooks) {
      delete settings.hooks[event];
    }

    await writeSettings(settings);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// PUT /:event/:index — Update a hook entry
router.put('/:event/:index', async (req, res) => {
  try {
    const { event, index: indexStr } = req.params;
    const index = parseInt(indexStr, 10);

    if (!(VALID_EVENTS as readonly string[]).includes(event as HookEvent)) {
      res.status(400).json({ success: false, error: `event must be one of: ${VALID_EVENTS.join(', ')}` });
      return;
    }
    if (isNaN(index) || index < 0) {
      res.status(400).json({ success: false, error: 'index must be a non-negative number' });
      return;
    }

    const settings = await readSettings();
    const eventHooks = settings.hooks?.[event];

    if (!eventHooks || index >= eventHooks.length) {
      res.status(404).json({ success: false, error: `Hook at index ${index} not found for event '${event}'` });
      return;
    }

    const { matcher, command } = req.body;

    if (matcher !== undefined) {
      if (typeof matcher !== 'string' || !matcher) {
        res.status(400).json({ success: false, error: 'matcher must be a non-empty string' });
        return;
      }
      eventHooks[index].matcher = matcher;
    }

    if (command !== undefined) {
      if (typeof command !== 'string' || !command) {
        res.status(400).json({ success: false, error: 'command must be a non-empty string' });
        return;
      }
      // Update command on the first hook entry in this matcher group
      if (eventHooks[index].hooks.length > 0) {
        eventHooks[index].hooks[0].command = command;
      }
    }

    await writeSettings(settings);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
