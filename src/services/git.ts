import { spawn, spawnSync } from 'child_process';
import { existsSync, readdirSync, writeFileSync, readFileSync, mkdirSync, unlinkSync, chmodSync, statfsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { ACTIVE_AGENT } from './agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(process.env.WORKSPACE || '/workspace');
export function getWorkspacePath(): string { return WORKSPACE; }
const SSH_DIR = `${process.env.HOME || '/root'}/.ssh`;
const SSH_KEY_PATH = `${SSH_DIR}/id_ed25519`;
const SSH_PUB_PATH = `${SSH_KEY_PATH}.pub`;

interface GitHubConfig {
  mode: 'full' | 'repo' | null;
  repoUrl: string | null;
  repoToken: string | null;
  authenticated: boolean;
  username: string | null;
  email: string | null;
  avatarUrl: string | null;
}

interface RepoInfo {
  name: string;
  path: string;
}

interface CloneResult {
  success: boolean;
  error?: string;
  path?: string;
  repoName?: string;
}

// GitHub access state
let gitHubConfig: GitHubConfig = {
  mode: null,
  repoUrl: null,
  repoToken: null,
  authenticated: false,
  username: null,
  email: null,
  avatarUrl: null,
};

/**
 * Check if Git is installed
 */
let gitInstalled: boolean | null = null;

export function isGitInstalled(): boolean {
  if (gitInstalled !== null) return gitInstalled;
  const result = spawnSync('git', ['--version'], { stdio: 'pipe', timeout: 5000 });
  gitInstalled = result.status === 0;
  return gitInstalled;
}

/**
 * Check if GitHub CLI is installed
 */
let ghInstalled: boolean | null = null;

export function isGhInstalled(): boolean {
  if (ghInstalled !== null) return ghInstalled;
  const result = spawnSync('gh', ['--version'], { stdio: 'pipe', timeout: 5000 });
  ghInstalled = result.status === 0;
  return ghInstalled;
}

/**
 * Check if authenticated with GitHub (gh auth status)
 */
export function isGhAuthenticated(): boolean {
  const result = spawnSync('gh', ['auth', 'status'], { stdio: 'pipe', timeout: 10000 });
  return result.status === 0;
}

/**
 * Load GitHub account info (username, email, avatar) via gh api.
 * Called after successful login and at startup restore.
 */
function loadGitHubAccountInfo(): void {
  try {
    const result = spawnSync('gh', ['api', 'user', '--jq', '.login,.email,.avatar_url'], {
      stdio: 'pipe',
      timeout: 10000,
    });
    if (result.status === 0) {
      const lines = result.stdout.toString().trim().split('\n');
      gitHubConfig.username = lines[0] || null;
      gitHubConfig.email = (lines[1] && lines[1] !== 'null') ? lines[1] : null;
      gitHubConfig.avatarUrl = lines[2] || null;
      console.log(`[GitHub] Account info loaded: @${gitHubConfig.username}`);
    }
  } catch (err) {
    console.warn('[GitHub] Failed to load account info:', (err as Error).message);
  }
}

/**
 * Initialize GitHub state at server startup.
 * If gh CLI is authenticated (token persisted via volume), restore state and load account info.
 */
export function initGitHub(): void {
  if (!isGhInstalled()) return;
  if (isGhAuthenticated()) {
    gitHubConfig.authenticated = true;
    gitHubConfig.mode = 'full';
    loadGitHubAccountInfo();
    console.log('[GitHub] Session restored from persisted token');
  }
}

/**
 * Check if a GitHub token is configured (env or repo-specific)
 */
export function hasGitHubToken(): boolean {
  return !!process.env.GITHUB_TOKEN || !!gitHubConfig.repoToken;
}

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

/**
 * Configure full GitHub access (gh auth login)
 */
export function startGitHubFullLogin(callbacks: {
  onCode?: (code: string) => void;
  onUrl?: (url: string) => void;
  onSuccess?: () => void;
  onError?: () => void;
} = {}): Promise<boolean> {
  return new Promise((resolve) => {
    console.log('\n🔐 Starting full GitHub login...\n');

    gitHubConfig.mode = 'full';

    let proc;
    try {
      proc = spawn('gh', ['auth', 'login', '--web', '-h', 'github.com'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      console.log('\n❌ gh CLI not installed — cannot authenticate with GitHub\n');
      if (callbacks.onError) callbacks.onError();
      return resolve(false);
    }

    let output = '';

    proc.on('error', (err: Error) => {
      console.log(`\n❌ gh CLI not available: ${err.message}\n`);
      if (callbacks.onError) callbacks.onError();
      resolve(false);
    });

    proc.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      console.log(text);

      // Capture verification code
      const codeMatch = text.match(/([A-Z0-9]{4}-[A-Z0-9]{4})/);
      if (codeMatch && callbacks.onCode) {
        callbacks.onCode(codeMatch[1]);
      }

      // Capture URL
      const urlMatch = text.match(/(https:\/\/github\.com\/login\/device)/);
      if (urlMatch && callbacks.onUrl) {
        callbacks.onUrl(urlMatch[1]);
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      console.log(text);

      // gh sometimes sends info to stderr
      const codeMatch = text.match(/([A-Z0-9]{4}-[A-Z0-9]{4})/);
      if (codeMatch && callbacks.onCode) {
        callbacks.onCode(codeMatch[1]);
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        gitHubConfig.authenticated = true;
        loadGitHubAccountInfo();
        console.log('\n✓ GitHub authenticated successfully\n');
        if (callbacks.onSuccess) callbacks.onSuccess();
        resolve(true);
      } else {
        console.log('\n❌ GitHub authentication error\n');
        if (callbacks.onError) callbacks.onError();
        resolve(false);
      }
    });
  });
}


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

/**
 * Extract the repo name from a URL
 */
function extractRepoName(url: string): string {
  const match = url.match(/[/:]([^/]+?)(?:\.git)?$/);
  return match ? match[1] : 'repo';
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

/**
 * Create a temporary GIT_ASKPASS script that echoes a token.
 * This avoids embedding the token in the clone URL (visible in `ps`).
 * The token is stored in a separate file to avoid shell interpretation issues.
 * Returns the script path; caller must clean up after use via cleanupAskpass().
 */
function createAskpassScript(token: string): string {
  const name = `git-askpass-${randomBytes(4).toString('hex')}`;
  const scriptPath = join(tmpdir(), `${name}.sh`);
  const tokenPath = join(tmpdir(), `${name}.token`);
  // Write token to a separate file — avoids shell metacharacter injection
  writeFileSync(tokenPath, token, { mode: 0o600 });
  writeFileSync(scriptPath, `#!/bin/sh\ncat "${tokenPath}"\n`, { mode: 0o700 });
  return scriptPath;
}

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

/**
 * Configure git credentials for the repository
 */
function configureGitCredentials(url: string, token: string): void {
  try {
    const urlObj = new URL(url);
    const host = urlObj.host;

    // Write to $HOME/.git-credentials (standard location)
    const home = process.env.HOME || '/root';
    const credentialsFile = `${home}/.git-credentials`;

    // Warn if overwriting existing credential for this host
    if (existsSync(credentialsFile)) {
      try {
        const existing = readFileSync(credentialsFile, 'utf-8');
        if (existing.includes(`@${host}`)) {
          console.warn(`[Git] Overwriting existing credential for ${host}`);
          console.warn(`[Git] This may affect other repositories on ${host}`);
        }
      } catch { /* best effort — proceed with write */ }
    }

    writeFileSync(credentialsFile, `https://${token}@${host}\n`, { mode: 0o600 });

    // Configure global credential helper to use this file
    spawnSync('git', ['config', '--global', 'credential.helper', `store --file=${credentialsFile}`], { stdio: 'pipe' });

    console.log('✓ Git credentials configured\n');
  } catch (err) {
    console.error('Error configuring credentials:', (err as Error).message);
  }
}

/**
 * Get current GitHub configuration
 */
export function getGitHubConfig() {
  return {
    mode: gitHubConfig.mode,
    repoUrl: gitHubConfig.repoUrl,
    authenticated: gitHubConfig.authenticated || isGhAuthenticated(),
    hasToken: !!gitHubConfig.repoToken || !!process.env.GITHUB_TOKEN,
  };
}

/**
 * Check if an SSH key exists
 */
export function hasSSHKey(): boolean {
  return existsSync(SSH_KEY_PATH) && existsSync(SSH_PUB_PATH);
}

/**
 * Generate an SSH key pair. If `force` is true, regenerates even if a key exists.
 */
export function generateSSHKey(force = false): { success: boolean; exists?: boolean; error?: string } {
  if (!force && hasSSHKey()) {
    console.log('[SSH] SSH key already exists');
    return { success: true, exists: true };
  }

  // Remove existing keys if forcing regeneration
  if (force && hasSSHKey()) {
    try {
      unlinkSync(SSH_KEY_PATH);
      unlinkSync(SSH_PUB_PATH);
      console.log('[SSH] Removed existing SSH keys for regeneration');
    } catch { /* may not exist */ }
  }

  try {
    // Create .ssh directory if it doesn't exist
    if (!existsSync(SSH_DIR)) {
      mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
    }

    // Generate ed25519 key without passphrase
    console.log('[SSH] Generating new SSH key...');
    spawnSync('ssh-keygen', ['-t', 'ed25519', '-f', SSH_KEY_PATH, '-N', '', '-C', 'codeck'], {
      stdio: 'pipe',
    });

    // Set correct permissions using fs.chmodSync (no shell needed)
    chmodSync(SSH_KEY_PATH, 0o600);
    chmodSync(SSH_PUB_PATH, 0o644);

    // Pin GitHub's SSH host keys (avoids prompt without disabling verification)
    const knownHostsPath = `${SSH_DIR}/known_hosts`;
    const githubHostKeys = [
      'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
      'github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=',
      'github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=',
    ].join('\n') + '\n';
    writeFileSync(knownHostsPath, githubHostKeys, { mode: 0o644 });

    const sshConfig = `Host github.com
  StrictHostKeyChecking yes
  UserKnownHostsFile ${knownHostsPath}
  IdentityFile ${SSH_KEY_PATH}
`;
    writeFileSync(`${SSH_DIR}/config`, sshConfig, { mode: 0o600 });

    console.log('[SSH] SSH key generated successfully');
    invalidateSSHCache();
    return { success: true, exists: false };
  } catch (err) {
    console.error('[SSH] Error generating key:', (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Get the SSH public key
 */
export function getSSHPublicKey(): string | null {
  if (!hasSSHKey()) {
    const result = generateSSHKey();
    if (!result.success) {
      return null;
    }
  }

  try {
    return readFileSync(SSH_PUB_PATH, 'utf-8').trim();
  } catch (err) {
    console.error('[SSH] Error reading public key:', (err as Error).message);
    return null;
  }
}

/**
 * Check if we can connect to GitHub via SSH (with 30s cache)
 */
let sshTestCache = { result: false, checkedAt: 0 };
const SSH_TEST_CACHE_TTL = 30000;

export function testSSHConnection(): boolean {
  const now = Date.now();
  if (now - sshTestCache.checkedAt < SSH_TEST_CACHE_TTL) {
    return sshTestCache.result;
  }

  // ssh -T git@github.com returns exit code 1 but prints "successfully authenticated" to stderr
  const result = spawnSync('ssh', ['-T', 'git@github.com'], { stdio: 'pipe', timeout: 10000 });
  const output = (result.stdout?.toString() || '') + (result.stderr?.toString() || '');
  sshTestCache = { result: output.includes('successfully authenticated'), checkedAt: now };
  return sshTestCache.result;
}

export function invalidateSSHCache(): void {
  sshTestCache = { result: false, checkedAt: 0 };
}

/**
 * Delete the SSH key pair
 */
export function deleteSSHKey(): { success: boolean; error?: string } {
  try {
    if (existsSync(SSH_KEY_PATH)) unlinkSync(SSH_KEY_PATH);
    if (existsSync(SSH_PUB_PATH)) unlinkSync(SSH_PUB_PATH);
    invalidateSSHCache();
    console.log('[SSH] SSH key deleted');
    return { success: true };
  } catch (err) {
    console.error('[SSH] Error deleting key:', (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Full Git status
 */
export function getGitStatus() {
  const ghAuth = isGhAuthenticated();
  const repos = listRepositories();

  return {
    installed: isGitInstalled(),
    ghInstalled: isGhInstalled(),
    ghAuthenticated: ghAuth,
    hasGitHubToken: hasGitHubToken(),
    hasRepository: repos.length > 0,
    workspaceEmpty: isWorkspaceEmpty(),
    workspace: WORKSPACE,
    repoName: repos.length > 0 ? repos.map(r => r.name).join(', ') : null,
    repositories: repos,
    github: {
      mode: gitHubConfig.mode || (ghAuth ? 'full' : null),
      repoUrl: gitHubConfig.repoUrl,
      authenticated: gitHubConfig.authenticated || ghAuth,
      username: gitHubConfig.username,
      email: gitHubConfig.email,
      avatarUrl: gitHubConfig.avatarUrl,
    },
    ssh: {
      hasKey: hasSSHKey(),
      authenticated: hasSSHKey() ? testSSHConnection() : false,
    },
  };
}

/**
 * Generates/updates /workspace/${ACTIVE_AGENT.instructionFile} (Layer 2) with the project listing.
 * This is the ONLY instruction file this function manages.
 * Layer 1 is managed by the preset system.
 */
export function updateClaudeMd(): boolean {
  try {
    const repos = listRepositories();
    const claudeMdPath = `${WORKSPACE}/${ACTIVE_AGENT.instructionFile}`;

    // Generate project list — sanitize names to prevent instruction injection
    let projectsList: string;
    if (repos.length === 0) {
      projectsList = '_No projects cloned yet_';
    } else {
      projectsList = repos.map(r => {
        const safeName = r.name.replace(/[^a-zA-Z0-9_\-. ]/g, '').slice(0, 100);
        return `- **${safeName}/** - \`${r.path}\``;
      }).join('\n');
    }

    // If CLAUDE.md already exists, try to update the projects marker in-place
    if (existsSync(claudeMdPath)) {
      const existing = readFileSync(claudeMdPath, 'utf-8');
      const presetMarker = /<!-- PROJECTS_LIST[^>]*-->[^]*$/;

      if (presetMarker.test(existing)) {
        const updated = existing.replace(
          presetMarker,
          `<!-- PROJECTS_LIST (auto-generated, do not edit manually) -->\n${projectsList}`
        );
        writeFileSync(claudeMdPath, updated);
        console.log(`[Workspace] ${ACTIVE_AGENT.instructionFile} project list updated`);
        return true;
      }

      // Legacy marker
      if (existing.includes('{{PROJECTS_LIST}}')) {
        writeFileSync(claudeMdPath, existing.replace('{{PROJECTS_LIST}}', projectsList));
        console.log(`[Workspace] ${ACTIVE_AGENT.instructionFile} updated (legacy marker)`);
        return true;
      }
    }

    // No instruction file exists — use the template from src/templates/CLAUDE.md
    const templatePath = join(__dirname, '../templates/CLAUDE.md');
    let content: string;

    if (existsSync(templatePath)) {
      content = readFileSync(templatePath, 'utf-8');
      // Replace the default project list with actual projects
      const marker = /<!-- PROJECTS_LIST[^>]*-->[^]*$/;
      if (marker.test(content)) {
        content = content.replace(
          marker,
          `<!-- PROJECTS_LIST (auto-generated, do not edit manually) -->\n${projectsList}`
        );
      }
      console.log(`[Workspace] ${ACTIVE_AGENT.instructionFile} created from template`);
    } else {
      content = `# Workspace Projects\n\n<!-- PROJECTS_LIST (auto-generated, do not edit manually) -->\n${projectsList}\n`;
      console.log(`[Workspace] ${ACTIVE_AGENT.instructionFile} created (fallback — template not found)`);
    }

    writeFileSync(claudeMdPath, content);
    return true;
  } catch (err) {
    console.error(`[Workspace] Error updating ${ACTIVE_AGENT.instructionFile}:`, (err as Error).message);
    return false;
  }
}
