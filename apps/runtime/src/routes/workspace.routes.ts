import { Router } from 'express';
import { spawn, execFile } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const WORKSPACE = resolve(process.env.WORKSPACE || '/workspace');
const router = Router();

// Concurrency guard — only one export at a time
let exportInProgress = false;
const EXPORT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Export workspace as tar.gz
// Agent data (.codeck/) is inside /workspace, so it's included naturally.
router.get('/export', async (_req, res) => {
  if (exportInProgress) {
    res.status(429).json({ error: 'Export already in progress' });
    return;
  }

  if (!existsSync(WORKSPACE)) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  // Pre-flight workspace size check (approximate via du)
  const MAX_EXPORT_SIZE_GB = parseInt(process.env.MAX_EXPORT_SIZE_GB || '10', 10);
  try {
    const { stdout: duOutput } = await execFileAsync('du', ['-sk', '--exclude=.git', '--exclude=node_modules', WORKSPACE], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    const sizeKB = duOutput.split('\t')[0];
    const sizeGB = parseInt(sizeKB, 10) / 1024 / 1024;
    if (sizeGB > MAX_EXPORT_SIZE_GB) {
      res.status(413).json({
        error: `Workspace size (${sizeGB.toFixed(2)}GB) exceeds export limit (${MAX_EXPORT_SIZE_GB}GB)`,
      });
      return;
    }
  } catch {
    // Size check failure is non-fatal — proceed with export
  }

  exportInProgress = true;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `codeck-export-${timestamp}.tar.gz`;

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const proc = spawn(
    'tar', [
      '-czf', '-', '-C', WORKSPACE,
      '--dereference',  // Archive symlink targets instead of links (CVE-2025-45582 mitigation)
      '--exclude=.git',
      '--exclude=node_modules',
      // Exclude sensitive authentication and session data
      '--exclude=.codeck/auth.json',
      '--exclude=.codeck/sessions.json',
      '--exclude=.codeck/state',
      '--exclude=.git-credentials',
      '.',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // Kill tar if it exceeds the timeout
  const timeout = setTimeout(() => {
    console.error('[Workspace] Export timed out after 5 minutes');
    proc.kill('SIGTERM');
  }, EXPORT_TIMEOUT_MS);

  proc.stdout.pipe(res);

  proc.on('error', (err) => {
    clearTimeout(timeout);
    exportInProgress = false;
    console.error('[Workspace] Export error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Export failed' });
    }
  });

  proc.stderr.on('data', (data: Buffer) => {
    console.error('[Workspace] tar stderr:', data.toString());
  });

  proc.on('close', (code) => {
    clearTimeout(timeout);
    exportInProgress = false;
    if (code !== 0 && !res.headersSent) {
      res.status(500).json({ error: 'Export failed' });
    }
  });
});

// Import workspace from tar.gz
router.post('/import', async (req, res) => {
  const { data } = req.body;
  if (!data || typeof data !== 'string') {
    res.status(400).json({ error: 'Base64-encoded tar.gz data required' });
    return;
  }

  const buffer = Buffer.from(data, 'base64');
  const MAX_IMPORT_SIZE = 500 * 1024 * 1024; // 500 MB
  if (buffer.length > MAX_IMPORT_SIZE) {
    res.status(413).json({ error: `Import too large (max ${MAX_IMPORT_SIZE / 1024 / 1024} MB)` });
    return;
  }

  const { writeFile: writeFileAsync, rm, mkdir } = await import('fs/promises');
  const { join } = await import('path');
  const tmpDir = join(WORKSPACE, '.workspace-import-tmp-' + Date.now());

  try {
    await mkdir(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, 'import.tar.gz');
    await writeFileAsync(tmpFile, buffer);

    // Extract into workspace — merge with existing files
    await new Promise<void>((resolve, reject) => {
      const extract = spawn('tar', [
        'xzf', tmpFile, '-C', WORKSPACE,
        '--no-same-owner',
        '--no-same-permissions',
        '--warning=no-timestamp',
        '--skip-old-files', // don't overwrite existing files
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      extract.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      extract.on('error', reject);
      extract.on('close', () => {
        if (stderr) console.warn('[Workspace Import]', stderr.slice(0, 500));
        resolve();
      });
    });

    await rm(tmpDir, { recursive: true, force: true });
    res.json({ success: true, message: 'Workspace imported' });
  } catch (err) {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    console.error('[Workspace Import] Failed:', (err as Error).message);
    res.status(500).json({ error: 'Import failed: ' + (err as Error).message });
  }
});

export default router;
