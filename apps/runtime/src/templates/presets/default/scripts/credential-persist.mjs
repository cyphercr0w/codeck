#!/usr/bin/env node
/**
 * SessionStart hook — Persist integration credentials across container rebuilds.
 *
 * Problem: CLI tools (gh, vercel, etc.) store auth in ~/.config/ or similar
 * ephemeral paths. Container rebuilds wipe these, losing all logins.
 *
 * Solution: symlink each tool's config directory to /workspace/.codeck/credentials/
 * which lives on a persistent volume. On session start, restore symlinks.
 *
 * This runs BEFORE any auth checks, so integrations appear connected immediately.
 */

import { existsSync, mkdirSync, symlinkSync, readdirSync, statSync, lstatSync, cpSync, rmSync, renameSync } from 'fs';
import { join, dirname } from 'path';

const PERSIST_DIR = '/workspace/.codeck/credentials';
if (!existsSync(PERSIST_DIR)) mkdirSync(PERSIST_DIR, { recursive: true, mode: 0o700 });

// Map: persistent name → ephemeral system path
const CREDENTIAL_PATHS = {
  'gh':       '/root/.config/gh',           // GitHub CLI
  'vercel':   '/root/.local/share/com.vercel.cli', // Vercel CLI (v39+)
  'vercel2':  '/root/.vercel',              // Vercel CLI (legacy path)
  'npm':      '/root/.npmrc',               // npm auth tokens
};

for (const [name, systemPath] of Object.entries(CREDENTIAL_PATHS)) {
  const persistPath = join(PERSIST_DIR, name);

  try {
    // Case 1: System path exists as real dir/file (not symlink) — migrate to persistent
    if (existsSync(systemPath)) {
      const lstat = lstatSync(systemPath, { throwIfNoEntry: false });
      if (lstat && !lstat.isSymbolicLink() && !existsSync(persistPath)) {
        // First time: copy real data to persistent storage
        if (lstat.isDirectory()) {
          cpSync(systemPath, persistPath, { recursive: true });
        } else {
          cpSync(systemPath, persistPath);
        }
        // Try to replace with symlink; if busy (process using it), just keep the copy
        // The symlink will be created on next session start (post-rebuild)
        try {
          rmSync(systemPath, { recursive: true, force: true });
          symlinkSync(persistPath, systemPath);
          console.error(`[CredentialPersist] Migrated ${name}: ${systemPath} → ${persistPath}`);
        } catch {
          console.error(`[CredentialPersist] Copied ${name} to persistent (symlink on next restart)`);
        }
      } else if (lstat && !lstat.isSymbolicLink() && existsSync(persistPath)) {
        // Sync: real dir exists AND persistent exists — update persistent copy
        if (lstat.isDirectory()) {
          cpSync(systemPath, persistPath, { recursive: true });
        } else {
          cpSync(systemPath, persistPath);
        }
      }
    }

    // Case 2: Persistent data exists but system path doesn't (post-rebuild) — restore symlink
    if (existsSync(persistPath) && !existsSync(systemPath)) {
      const parentDir = dirname(systemPath);
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
      symlinkSync(persistPath, systemPath);
      console.error(`[CredentialPersist] Restored symlink: ${systemPath} → ${persistPath}`);
    }

    // Case 3: Both exist but system path is not a symlink — conflict, prefer persistent
    if (existsSync(persistPath) && existsSync(systemPath)) {
      const ls = lstatSync(systemPath, { throwIfNoEntry: false });
      if (ls && !ls.isSymbolicLink()) {
        // Real file conflicts with persistent — backup and replace
        const backupPath = systemPath + '.bak';
        try { renameSync(systemPath, backupPath); } catch { rmSync(systemPath, { recursive: true, force: true }); }
        symlinkSync(persistPath, systemPath);
        console.error(`[CredentialPersist] Replaced ${name} with symlink (backed up original)`);
      }
    }
  } catch (err) {
    // Non-fatal — don't block session start
    console.error(`[CredentialPersist] Warning for ${name}: ${err?.message || err}`);
  }
}
