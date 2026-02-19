import { Router } from 'express';
import { listPresets, getPresetStatus, applyPreset, isValidPresetId } from '../services/preset.js';
import { broadcastStatus } from '../web/websocket.js';
import { updateClaudeMd } from '../services/git.js';

const router = Router();

// List all available presets (reads manifests dynamically)
router.get('/', (_req, res) => {
  res.json(listPresets());
});

// Get preset configuration status
router.get('/status', (_req, res) => {
  res.json(getPresetStatus());
});

// Apply a preset by ID
router.post('/apply', async (req, res) => {
  const { presetId } = req.body;
  if (!presetId || typeof presetId !== 'string') {
    res.status(400).json({ error: 'presetId is required' });
    return;
  }
  if (!isValidPresetId(presetId)) {
    res.status(400).json({ error: 'Invalid presetId. Must be alphanumeric with hyphens/underscores.' });
    return;
  }

  try {
    await applyPreset(presetId);
    // Refresh /workspace/CLAUDE.md with project list (Layer 2)
    updateClaudeMd();
    broadcastStatus();
    res.json({ success: true, presetId });
  } catch (err) {
    console.error('[Preset] Error applying preset:', (err as Error).message);
    res.status(500).json({ error: 'Failed to apply preset. Check server logs for details.' });
  }
});

// Reset current preset to defaults (force re-apply, overwrites all files including user data)
router.post('/reset', async (_req, res) => {
  const status = getPresetStatus();
  if (!status.configured || !status.presetId) {
    res.status(400).json({ error: 'No preset configured' });
    return;
  }

  try {
    await applyPreset(status.presetId, true);
    updateClaudeMd();
    broadcastStatus();
    res.json({ success: true, presetId: status.presetId });
  } catch (err) {
    console.error('[Preset] Error resetting preset:', (err as Error).message);
    res.status(500).json({ error: 'Failed to reset preset. Check server logs for details.' });
  }
});

export default router;
