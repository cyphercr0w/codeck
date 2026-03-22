/**
 * SSH key management: generation, testing, deletion, known_hosts setup.
 */
import { spawnSync, execFile } from 'child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, chmodSync } from 'fs';

export const SSH_DIR = `${process.env.HOME || '/root'}/.ssh`;
const SSH_KEY_PATH = `${SSH_DIR}/id_ed25519`;
const SSH_PUB_PATH = `${SSH_KEY_PATH}.pub`;

// ── SSH key existence ────────────────────────────────────────────────
/**
 * Check if an SSH key exists
 */
export function hasSSHKey(): boolean {
  return existsSync(SSH_KEY_PATH) && existsSync(SSH_PUB_PATH);
}

// ── Key generation ───────────────────────────────────────────────────
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
    const keygen = spawnSync('ssh-keygen', ['-t', 'ed25519', '-f', SSH_KEY_PATH, '-N', '', '-C', 'codeck'], {
      stdio: 'pipe',
    });

    if (keygen.status !== 0) {
      const stderr = keygen.stderr?.toString().trim() || 'unknown error';
      console.error('[SSH] ssh-keygen failed:', stderr);
      return { success: false, error: `ssh-keygen failed: ${stderr}` };
    }

    if (!existsSync(SSH_KEY_PATH)) {
      return { success: false, error: 'ssh-keygen ran but key file was not created' };
    }

    // Set correct permissions
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

// ── Public key ───────────────────────────────────────────────────────
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

// ── SSH connection test ──────────────────────────────────────────────
/**
 * Check if we can connect to GitHub via SSH.
 * Cached permanently — checked asynchronously to avoid blocking the event loop.
 * getGitStatus() always returns the cached value (never blocks).
 * Only re-checked after explicit SSH key generation/deletion.
 */
let sshTestCache: { result: boolean; checked: boolean; checking: boolean } = {
  result: false,
  checked: false,
  checking: false,
};

export function testSSHConnection(): boolean {
  if (!sshTestCache.checked && !sshTestCache.checking) {
    // Run async — don't block the event loop
    sshTestCache.checking = true;
    execFile('ssh', ['-T', '-o', 'ConnectTimeout=5', 'git@github.com'], { timeout: 6000 }, (err: any, stdout: string, stderr: string) => {
      const output = (stdout || '') + (stderr || '');
      sshTestCache = { result: output.includes('successfully authenticated'), checked: true, checking: false };
    });
  }
  return sshTestCache.result;
}

export function invalidateSSHCache(): void {
  sshTestCache = { result: false, checked: false, checking: false };
}

// ── Key deletion ─────────────────────────────────────────────────────
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
