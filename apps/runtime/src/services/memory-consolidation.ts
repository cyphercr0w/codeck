/**
 * Memory Consolidation Service
 *
 * Orchestrates the consolidation pipeline:
 * 1. Run existing memory-consolidation.mjs (Haiku extraction → pending-consolidation.md)
 * 2. Run consolidation-apply.mjs (apply suggestions to durable memory)
 * 3. Run consolidation-decay.mjs (Ebbinghaus decay on WARM tier)
 * 4. Run generate-weekly-digest.mjs (weekly stats digest)
 *
 * Also provides status/query APIs for archive data.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import cron from 'node-cron';

const execFileAsync = promisify(execFile);

// Weekly cron job handle (Sunday 02:00 UTC)
let cronJob: cron.ScheduledTask | null = null;

const WORKSPACE = resolve(process.env.WORKSPACE || '/workspace');
const CODECK_DIR = join(WORKSPACE, '.codeck');
const SCRIPTS_DIR = join(CODECK_DIR, 'scripts');
const MEMORY_DIR = join(CODECK_DIR, 'memory');
const ARCHIVE_DIR = join(MEMORY_DIR, 'archive');
const WARM_DIR = join(ARCHIVE_DIR, 'warm');
const COLD_DIR = join(ARCHIVE_DIR, 'cold');
const DIGESTS_DIR = join(MEMORY_DIR, 'digests');
const AUDIT_PATH = join(ARCHIVE_DIR, 'consolidation-audit.json');
const STATE_DIR = join(CODECK_DIR, 'state');
const CONSOLIDATION_STATE_PATH = join(STATE_DIR, 'consolidation-state.json');
const DECAY_STATE_PATH = join(ARCHIVE_DIR, 'decay-state.json');
const LAST_RUN_PATH = join(STATE_DIR, 'last-consolidation.txt');
const PENDING_PATH = join(MEMORY_DIR, 'pending-consolidation.md');

// Mutex to prevent concurrent consolidation runs
let isRunning = false;

interface ConsolidationResult {
  success: boolean;
  steps: StepResult[];
  duration: number;
  error?: string;
}

interface StepResult {
  step: string;
  success: boolean;
  output: string;
  duration: number;
  error?: string;
}

/**
 * Run a single script step with timeout.
 */
async function runStep(name: string, scriptPath: string): Promise<StepResult> {
  const start = Date.now();

  if (!existsSync(scriptPath)) {
    return {
      step: name,
      success: false,
      output: '',
      duration: 0,
      error: `Script not found: ${scriptPath}`,
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync('node', [scriptPath], {
      timeout: 120000, // 2 minute timeout per step
      cwd: WORKSPACE,
      env: { ...process.env },
    });

    const output = (stdout + (stderr ? `\n[stderr] ${stderr}` : '')).trim();
    return {
      step: name,
      success: true,
      output: output.slice(0, 2000), // Cap output size
      duration: Date.now() - start,
    };
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      step: name,
      success: false,
      output: ((err.stdout || '') + (err.stderr || '')).trim().slice(0, 2000),
      duration: Date.now() - start,
      error: err.message?.slice(0, 500),
    };
  }
}

/**
 * Run the full consolidation pipeline.
 * Steps: extract → apply → decay → digest
 */
export async function runConsolidation(): Promise<ConsolidationResult> {
  if (isRunning) {
    return { success: false, steps: [], duration: 0, error: 'Consolidation already running' };
  }

  isRunning = true;
  const start = Date.now();
  const steps: StepResult[] = [];

  try {
    // Step 1: Extract (existing Haiku-based script)
    const extractResult = await runStep(
      'extract',
      join(SCRIPTS_DIR, 'memory-consolidation.mjs'),
    );
    steps.push(extractResult);

    // Step 2: Apply (our new script — only runs if pending file exists)
    const applyResult = await runStep(
      'apply',
      join(SCRIPTS_DIR, 'consolidation-apply.mjs'),
    );
    steps.push(applyResult);

    // Step 3: Decay (Ebbinghaus on WARM tier)
    const decayResult = await runStep(
      'decay',
      join(SCRIPTS_DIR, 'consolidation-decay.mjs'),
    );
    steps.push(decayResult);

    // Step 4: Weekly digest
    const digestResult = await runStep(
      'digest',
      join(SCRIPTS_DIR, 'generate-weekly-digest.mjs'),
    );
    steps.push(digestResult);

    const allSuccess = steps.every(s => s.success);
    return {
      success: allSuccess,
      steps,
      duration: Date.now() - start,
    };
  } catch (e) {
    return {
      success: false,
      steps,
      duration: Date.now() - start,
      error: (e as Error).message,
    };
  } finally {
    isRunning = false;
  }
}

/**
 * Get consolidation status: last run times, pending count, audit summary.
 */
export function getConsolidationStatus(): object {
  // Last extract run
  let lastExtractRun: number | null = null;
  if (existsSync(LAST_RUN_PATH)) {
    try {
      lastExtractRun = parseInt(readFileSync(LAST_RUN_PATH, 'utf-8').trim(), 10) || null;
    } catch { /* ignore */ }
  }

  // Last apply run
  let lastApplyRun: number | null = null;
  let lastApplyResult: object | null = null;
  if (existsSync(CONSOLIDATION_STATE_PATH)) {
    try {
      const state = JSON.parse(readFileSync(CONSOLIDATION_STATE_PATH, 'utf-8'));
      lastApplyRun = state.lastApplyRun || null;
      lastApplyResult = state.lastApplyResult || null;
    } catch { /* ignore */ }
  }

  // Last decay run
  let lastDecayRun: number | null = null;
  let lastDecayResult: object | null = null;
  if (existsSync(DECAY_STATE_PATH)) {
    try {
      const state = JSON.parse(readFileSync(DECAY_STATE_PATH, 'utf-8'));
      lastDecayRun = state.lastDecayRun || null;
      lastDecayResult = state.lastDecayResult || null;
    } catch { /* ignore */ }
  }

  // Pending consolidation
  let pendingExists = existsSync(PENDING_PATH);
  let pendingSize = 0;
  if (pendingExists) {
    try { pendingSize = statSync(PENDING_PATH).size; } catch { /* ignore */ }
  }

  // Audit log summary
  let auditRuns = 0;
  let lastAuditEntry: object | null = null;
  if (existsSync(AUDIT_PATH)) {
    try {
      const audit = JSON.parse(readFileSync(AUDIT_PATH, 'utf-8'));
      auditRuns = audit.runs?.length || 0;
      lastAuditEntry = audit.runs?.[audit.runs.length - 1] || null;
    } catch { /* ignore */ }
  }

  // Archive tier counts
  const warmCount = existsSync(WARM_DIR)
    ? readdirSync(WARM_DIR).filter(f => f.endsWith('.md')).length
    : 0;
  const coldCount = existsSync(COLD_DIR)
    ? readdirSync(COLD_DIR).filter(f => f.endsWith('.md') && !f.endsWith('.summary.md')).length
    : 0;
  const coldSummaryCount = existsSync(COLD_DIR)
    ? readdirSync(COLD_DIR).filter(f => f.endsWith('.summary.md')).length
    : 0;

  // Digest count
  const digestCount = existsSync(DIGESTS_DIR)
    ? readdirSync(DIGESTS_DIR).filter(f => f.endsWith('.md')).length
    : 0;

  return {
    running: isRunning,
    lastExtractRun,
    lastApplyRun,
    lastApplyResult,
    lastDecayRun,
    lastDecayResult,
    pending: { exists: pendingExists, sizeBytes: pendingSize },
    audit: { totalRuns: auditRuns, lastEntry: lastAuditEntry },
    tiers: {
      warm: { count: warmCount },
      cold: { count: coldCount, summaries: coldSummaryCount },
    },
    digests: { count: digestCount },
  };
}

/**
 * Query archived data by tier.
 */
export function queryArchive(tier?: string, limit = 20, offset = 0): object {
  const tiers: Record<string, string> = {
    warm: WARM_DIR,
    cold: COLD_DIR,
    digests: DIGESTS_DIR,
  };

  if (tier && !tiers[tier]) {
    return { error: `Invalid tier: ${tier}. Use: warm, cold, digests` };
  }

  const results: Record<string, object[]> = {};

  const tiersToQuery = tier ? { [tier]: tiers[tier] } : tiers;

  for (const [tierName, tierDir] of Object.entries(tiersToQuery)) {
    if (!existsSync(tierDir)) {
      results[tierName] = [];
      continue;
    }

    const files = readdirSync(tierDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();

    const paged = files.slice(offset, offset + limit);
    results[tierName] = paged.map(file => {
      const filePath = join(tierDir, file);
      try {
        const stat = statSync(filePath);
        const content = readFileSync(filePath, 'utf-8');
        const preview = content.split('\n').slice(0, 5).join('\n');
        return {
          file,
          sizeBytes: stat.size,
          modifiedAt: stat.mtimeMs,
          preview: preview.slice(0, 300),
        };
      } catch {
        return { file, sizeBytes: 0, modifiedAt: 0, preview: '' };
      }
    });
  }

  return {
    tiers: results,
    pagination: { limit, offset },
  };
}

// ── Cron scheduling ──

/**
 * Start the weekly consolidation cron job.
 * Runs every Sunday at 02:00 UTC: extract → apply → decay → digest.
 */
export function initConsolidationCron(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }

  // Cron expression: minute(0) hour(2) dom(*) month(*) dow(0=Sunday)
  cronJob = cron.schedule('0 2 * * 0', async () => {
    console.log('[Consolidation] Weekly cron triggered');
    try {
      const result = await runConsolidation();
      const stepSummary = result.steps.map(s => `${s.step}:${s.success ? 'ok' : 'fail'}`).join(', ');
      console.log(`[Consolidation] Weekly cron complete (${result.duration}ms): ${stepSummary}`);
    } catch (e) {
      console.error('[Consolidation] Weekly cron failed:', (e as Error).message);
    }
  });

  console.log('[Consolidation] Weekly cron scheduled (Sunday 02:00 UTC)');
}

/**
 * Stop the weekly consolidation cron job.
 */
export function shutdownConsolidationCron(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log('[Consolidation] Weekly cron stopped');
  }
}
