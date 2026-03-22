/**
 * Git operations: clone, URL validation, disk checks, workspace queries.
 */
import { spawn, spawnSync } from 'child_process';
import { existsSync, readdirSync, writeFileSync, unlinkSync, statfsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { ACTIVE_AGENT } from '../agent.js';
import { gitHubConfig, configureGitCredentials } from './github-auth.js';
import { hasSSHKey, generateSSHKey } from './ssh.js';
import { updateClaudeMd, WORKSPACE } from './workspace.js';

// ── Interfaces ───────────────────────────────────────────────────────
export interface RepoInfo {
  name: string;
  path: string;
}

export interface CloneResult {
  success: boolean;
  error?: string;
  path?: string;
  repoName?: string;
}

// ── Git detection ────────────────────────────────────────────────────
let gitInstalled: boolean | null = null;

/**
 * Check if Git is installed
 */
export function isGitInstalled(): boolean {
  if (gitInstalled !== null) return gitInstalled;
  const result = spawnSync('git', ['--version'], { stdio: 'pipe', timeout: 5000 });
  gitInstalled = result.status === 0;
  return gitInstalled;
}

// ── Repository queries ───────────────────────────────────────────────
/**
 * Check if the workspace has a repository (or multiple)
 */
export function hasRepository(): boolean {
  // Check root level
  if (existsSync(`${WORKSPACE}/.git`)) return true;

  // Check subdirectories
  try {
    const dirs = readdirSync(WORKSPACE);
    return dirs.some(dir => {
      const gitPath = `${WORKSPACE}/${dir}/.git`;
      return existsSync(gitPath);
    });
  } catch {
    return false;
  }
}

/**
 * List all repositories in the workspace
 */
export function listRepositories(): RepoInfo[] {
  const repos: RepoInfo[] = [];

  // Check root level
  if (existsSync(`${WORKSPACE}/.git`)) {
    repos.push({ name: '.', path: WORKSPACE });
  }

  // Check subdirectories
  try {
    const dirs = readdirSync(WORKSPACE);
    for (const dir of dirs) {
      // Skip hidden folders, invalid names (Windows paths, etc.)
      if (dir.startsWith('.')) continue;
      if (dir.includes(':') || dir.includes('\\')) continue;

      const gitPath = `${WORKSPACE}/${dir}/.git`;
      if (existsSync(gitPath)) {
        repos.push({ name: dir, path: `${WORKSPACE}/${dir}` });
      }
    }
  } catch (e) {
    console.warn('[Git] Error listing repos:', (e as Error).message);
  }

  return repos;
}

/**
 * Check if the workspace is empty (ignores config files)
 */
export function isWorkspaceEmpty(): boolean {
  if (!existsSync(WORKSPACE)) {
    return true;
  }
  const files = readdirSync(WORKSPACE);
  // Ignore config/generated files — only count real project directories
  const realFiles = files.filter(f => f !== ACTIVE_AGENT.instructionFile && f !== '.gitkeep' && !f.startsWith('.'));
  return realFiles.length === 0;
}

// ── URL helpers ──────────────────────────────────────────────────────
/**
 * Convert GitHub URL to SSH format
 */
export function toSSHUrl(url: string): string {
  const match = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (match) {
    return `git@github.com:${match[1]}.git`;
  }
  return url;
}

/**
 * Validate a git repository URL to prevent malicious inputs.
 * Accepts HTTPS URLs and git@host:path SSH URLs.
 * Rejects local paths, --flag-like args, non-standard protocols,
 * control characters (Clone2Leak defense), and private/internal IP ranges (SSRF defense).
 */
export function isValidGitUrl(url: string): boolean {
  // Reject URLs with control characters (Clone2Leak CVE-2024-50349, CVE-2024-52006)
  if (/[\x00-\x1f\x7f]/.test(url)) return false;

  // SSH format: git@host:user/repo.git
  if (/^git@[\w.-]+:[\w./-]+$/.test(url)) return true;

  // HTTPS/HTTP format
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (!parsed.hostname) return false;

    const host = parsed.hostname;

    // Block localhost variants
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return false;

    // Block private/internal IP ranges (SSRF defense)
    if (/^10\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^169\.254\./.test(host)) return false; // Link-local / cloud metadata
    if (host.endsWith('.local') || host.endsWith('.internal')) return false;

    return true;
  } catch {
    return false;
  }
}

// ── Disk space ───────────────────────────────────────────────────────
const MIN_DISK_SPACE_BYTES = 500 * 1024 * 1024; // 500MB minimum free space for clone

/**
 * Check if enough disk space is available for a clone operation.
 * Returns null if OK, or an error message string if insufficient.
 */
export function checkDiskSpace(dir: string): string | null {
  try {
    const stats = statfsSync(dir);
    const availableBytes = stats.bavail * stats.bsize;
    if (availableBytes < MIN_DISK_SPACE_BYTES) {
      const availMB = Math.round(availableBytes / (1024 * 1024));
      return `Insufficient disk space: ${availMB}MB available, need at least 500MB`;
    }
    return null;
  } catch {
    // If stat fails, don't block the clone — let git report the error
    return null;
  }
}

// ── Directory removal ────────────────────────────────────────────────
/**
 * Remove a directory recursively using spawnSync with array args (no shell interpolation).
 */
function removeDirectory(path: string): void {
  if (!existsSync(path)) return;
  const result = spawnSync('rm', ['-rf', path], { stdio: 'pipe' });
  if (result.error) {
    console.warn(`[Git] Failed to remove ${path}: ${result.error.message}`);
  }
}

/**
 * Clean the workspace (except config files)
 */
export function cleanWorkspace(): boolean {
  try {
    const files = readdirSync(WORKSPACE);
    for (const file of files) {
      if (file === '.codeck') continue; // Preserve config directory
      removeDirectory(`${WORKSPACE}/${file}`);
    }
    console.log('[Workspace] Cleaned');
    return true;
  } catch (err) {
    console.error('[Workspace] Error cleaning:', (err as Error).message);
    return false;
  }
}

// ── Askpass helper ───────────────────────────────────────────────────
/**
 * Extract the repo name from a URL
 */
function extractRepoName(url: string): string {
  const match = url.match(/[/:]([^/]+?)(?:\.git)?$/);
  return match ? match[1] : 'repo';
}

/**
 * Create a temporary GIT_ASKPASS script that echoes a token.
 * This avoids embedding the token in the clone URL (visible in `ps`).
 * The token is stored in a separate file to avoid shell interpretation issues.
 * Returns the script path; caller must clean up after use via cleanupAskpass().
 */
export function createAskpassScript(token: string): string {
  const name = `git-askpass-${randomBytes(4).toString('hex')}`;
  const scriptPath = join(tmpdir(), `${name}.sh`);
  const tokenPath = join(tmpdir(), `${name}.token`);
  // Write token to a separate file — avoids shell metacharacter injection
  writeFileSync(tokenPath, token, { mode: 0o600 });
  writeFileSync(scriptPath, `#!/bin/sh\ncat "${tokenPath}"\n`, { mode: 0o700 });
  return scriptPath;
}

// ── Clone ────────────────────────────────────────────────────────────
const CLONE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const SIGKILL_GRACE_MS = 5000; // 5 seconds after SIGTERM before SIGKILL

/**
 * Clone a repository in the workspace (in subdirectory named after repo)
 */
export function cloneRepository(url: string, token?: string | null, useSSH = false): Promise<CloneResult> {
  return new Promise((resolve) => {
    // Validate URL before proceeding
    if (!isValidGitUrl(url)) {
      resolve({ success: false, error: 'Invalid repository URL. Use HTTPS or git@host:path format.' });
      return;
    }

    const repoName = extractRepoName(url);
    const targetDir = `${WORKSPACE}/${repoName}`;

    console.log(`\n📦 Cloning repository...\n   ${url}\n   -> ${targetDir}\n`);

    // Check if it already exists
    if (existsSync(targetDir)) {
      console.log(`⚠️  Directory ${repoName} already exists\n`);
      resolve({ success: false, error: 'Directory already exists', path: targetDir });
      return;
    }

    // Pre-flight disk space check
    const diskError = checkDiskSpace(WORKSPACE);
    if (diskError) {
      resolve({ success: false, error: diskError });
      return;
    }

    let cloneUrl = url;
    let askpassScript: string | null = null;
    const cloneEnv: Record<string, string> = { ...process.env as Record<string, string> };

    // If it's an SSH URL or SSH was requested
    if (url.startsWith('git@') || useSSH) {
      // Make sure the SSH key exists
      if (!hasSSHKey()) {
        generateSSHKey();
      }
      cloneUrl = url.startsWith('git@') ? url : toSSHUrl(url);
      console.log(`   Using SSH: ${cloneUrl}\n`);
    } else {
      // Determine which token to use for HTTPS — use GIT_ASKPASS to avoid token in process args
      const accessToken = token || gitHubConfig.repoToken || process.env.GITHUB_TOKEN;
      if (accessToken && url.includes('github.com')) {
        askpassScript = createAskpassScript(accessToken);
        cloneEnv.GIT_ASKPASS = askpassScript;
        cloneEnv.GIT_TERMINAL_PROMPT = '0';
      }
    }

    const proc = spawn('git', ['clone', '--', cloneUrl, repoName], {
      cwd: WORKSPACE,
      stdio: 'inherit',
      env: cloneEnv,
    });

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      console.log(`[Git] Clone timeout after ${CLONE_TIMEOUT_MS / 1000}s, sending SIGTERM`);
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (proc.exitCode === null) {
          console.log('[Git] Escalating to SIGKILL');
          proc.kill('SIGKILL');
        }
      }, SIGKILL_GRACE_MS);
    }, CLONE_TIMEOUT_MS);

    function cleanupAskpass(): void {
      if (askpassScript) {
        // Remove both the script and its companion token file
        const tokenPath = askpassScript.replace(/\.sh$/, '.token');
        try { unlinkSync(askpassScript); } catch { /* already gone */ }
        try { unlinkSync(tokenPath); } catch { /* already gone */ }
        askpassScript = null;
      }
    }

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (killTimer) clearTimeout(killTimer);
      cleanupAskpass();

      if (timedOut) {
        removeDirectory(targetDir);
        resolve({ success: false, error: 'Clone timed out (exceeded 10 minutes)' });
        return;
      }

      if (code === 0) {
        console.log(`\n✓ Repository cloned to ${repoName}\n`);

        // Configure git to use token for future push/pull (HTTPS only)
        if (!url.startsWith('git@') && !useSSH) {
          const accessToken = token || gitHubConfig.repoToken || process.env.GITHUB_TOKEN;
          if (accessToken && url.includes('github.com')) {
            configureGitCredentials(url, accessToken);
          }
        }

        // Update instruction file with the new project list
        updateClaudeMd();

        resolve({ success: true, path: targetDir, repoName });
      } else {
        // Clean up folder created by failed clone
        removeDirectory(targetDir);

        // Detect if it's a private repo without authentication
        const isPrivateRepoError = !url.startsWith('git@') && !useSSH &&
          !token && !gitHubConfig.repoToken && !process.env.GITHUB_TOKEN;

        let errorMsg = 'Error in git clone';
        if (isPrivateRepoError) {
          errorMsg = 'Error cloning repository. If private, use SSH or provide an access token.';
        }

        console.log(`\n❌ ${errorMsg}\n`);
        resolve({ success: false, error: errorMsg });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      if (killTimer) clearTimeout(killTimer);
      cleanupAskpass();
      removeDirectory(targetDir);
      console.error('Error:', err.message);
      resolve({ success: false, error: err.message });
    });
  });
}
