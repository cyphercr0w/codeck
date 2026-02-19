import { Router } from 'express';
import {
  getNetworkInfo, isPortExposed, getMappedPorts, getCodeckPort,
  addMappedPort, removeMappedPort, writePortOverride, spawnComposeRestart, canAutoRestart,
} from '../services/port-manager.js';
import { saveSessionState, updateAgentBinary } from '../services/console.js';

const router = Router();

// GET /api/system/network-info — returns network mode, mapped ports, container ID
router.get('/network-info', (_req, res) => {
  res.json(getNetworkInfo());
});

// POST /api/system/add-port — expose a port to the host, auto-restarting if possible
router.post('/add-port', (req, res) => {
  const { port } = req.body;
  if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
    res.status(400).json({ error: 'Invalid port number (1-65535)' });
    return;
  }

  if (isPortExposed(port)) {
    res.json({ success: true, alreadyMapped: true });
    return;
  }

  // Try auto-restart with new port mapping
  if (!canAutoRestart()) {
    res.json({
      success: false,
      requiresRestart: true,
      instructions: `Port ${port} is not mapped. Add "${port}:${port}" to docker/compose.override.yml and restart the container.`,
    });
    return;
  }

  try {
    // 1. Write docker/compose.override.yml on the host via helper container
    const allPorts = [...getMappedPorts(), port];
    writePortOverride(allPorts);

    // 2. Update in-memory state
    addMappedPort(port);

    // 3. Save session state so sessions auto-restore after restart
    saveSessionState('port-add', `Port ${port} has been exposed. Continue your previous task.`);

    // 4. Respond immediately
    res.json({ success: true, restarting: true });

    // 5. Spawn restart helper after response is sent
    setTimeout(() => {
      try {
        spawnComposeRestart();
      } catch (e) {
        // Rollback: remove the port we just added since restart failed
        removeMappedPort(port);
        console.error('[System] Failed to spawn restart, rolled back port add:', (e as Error).message);
      }
    }, 500);
  } catch (e) {
    console.error('[System] Auto-restart failed:', (e as Error).message);
    res.json({
      success: false,
      requiresRestart: true,
      instructions: `Auto-restart failed. Manually add "${port}:${port}" to docker/compose.override.yml and restart.`,
    });
  }
});

// POST /api/system/remove-port — remove a port mapping and restart
router.post('/remove-port', (req, res) => {
  const { port } = req.body;
  if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
    res.status(400).json({ error: 'Invalid port number (1-65535)' });
    return;
  }

  if (port === getCodeckPort()) {
    res.status(400).json({ error: 'Cannot remove the Codeck port' });
    return;
  }

  if (!isPortExposed(port)) {
    res.json({ success: true, notMapped: true });
    return;
  }

  if (!canAutoRestart()) {
    res.json({
      success: false,
      requiresRestart: true,
      instructions: `Remove the "${port}:${port}" line from docker/compose.override.yml and restart the container.`,
    });
    return;
  }

  try {
    // 1. Remove from in-memory state
    removeMappedPort(port);

    // 2. Rewrite override with remaining ports (or delete if none left)
    const remainingPorts = getMappedPorts();
    writePortOverride(remainingPorts);

    // 3. Save session state for auto-restore after restart
    saveSessionState('port-remove', `Port ${port} has been unmapped. Continue your previous task.`);

    // 4. Respond immediately
    res.json({ success: true, restarting: true, remainingPorts });

    // 5. Spawn restart helper after response is sent
    setTimeout(() => {
      try {
        spawnComposeRestart();
      } catch (e) {
        console.error('[System] Failed to spawn restart:', (e as Error).message);
      }
    }, 500);
  } catch (e) {
    console.error('[System] Port removal failed:', (e as Error).message);
    // Re-add the port since the override write failed
    addMappedPort(port);
    res.json({
      success: false,
      requiresRestart: true,
      instructions: `Auto-restart failed. Manually edit docker/compose.override.yml and restart.`,
    });
  }
});

// POST /api/system/update-agent — safely update the agent CLI binary
router.post('/update-agent', (_req, res) => {
  try {
    const result = updateAgentBinary();
    res.json({ success: true, ...result });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.log(`[System] Agent CLI update failed: ${detail}`);
    res.status(500).json({ success: false, error: 'Agent update failed' });
  }
});

export default router;
