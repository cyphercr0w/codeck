/**
 * Git service — thin facade that re-exports from focused sub-modules.
 *
 * All external consumers import from this file (`../services/git.js`),
 * so no import paths need to change elsewhere in the codebase.
 *
 * Sub-modules:
 *   git/github-auth.ts — GitHub CLI authentication & credential helpers
 *   git/ssh.ts          — SSH key management
 *   git/operations.ts   — Clone, URL validation, disk checks, repo queries
 *   git/workspace.ts    — Workspace CLAUDE.md management
 */

// ── GitHub auth ──────────────────────────────────────────────────────
export {
  initGitHub,
  isGhInstalled,
  isGhAuthenticated,
  invalidateGhAuthCache,
  startGitHubFullLogin,
  hasGitHubToken,
  getGitHubConfig,
  configureGitCredentials,
  gitHubConfig,
} from './git/github-auth.js';

export type { GitHubConfig } from './git/github-auth.js';

// ── SSH ──────────────────────────────────────────────────────────────
export {
  hasSSHKey,
  generateSSHKey,
  getSSHPublicKey,
  testSSHConnection,
  invalidateSSHCache,
  deleteSSHKey,
  SSH_DIR,
} from './git/ssh.js';

// ── Git operations ───────────────────────────────────────────────────
export {
  cloneRepository,
  isValidGitUrl,
  toSSHUrl,
  checkDiskSpace,
  cleanWorkspace,
  isGitInstalled,
  hasRepository,
  listRepositories,
  isWorkspaceEmpty,
  invalidateRepoCache,
  createAskpassScript,
  getGitDiff,
  getRepoRemote,
} from './git/operations.js';

export type { RepoInfo, CloneResult } from './git/operations.js';

// ── Workspace ────────────────────────────────────────────────────────
export {
  updateClaudeMd,
  getWorkspacePath,
  WORKSPACE,
} from './git/workspace.js';

// ── Composite: getGitStatus ──────────────────────────────────────────
import { isGitInstalled, hasRepository, listRepositories, isWorkspaceEmpty } from './git/operations.js';
import { isGhInstalled, isGhAuthenticated, hasGitHubToken, gitHubConfig } from './git/github-auth.js';
import { hasSSHKey, testSSHConnection } from './git/ssh.js';
import { WORKSPACE } from './git/workspace.js';

/**
 * Full Git status — aggregates data from all sub-modules.
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
