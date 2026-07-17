/**
 * GitHub API reads for the in-UI Pull Requests / Issues view.
 *
 * Shells out to `gh api` (reusing the stored gh keyring credential — zero token
 * plumbing), matching the existing `loadGitHubAccountInfo` precedent. No octokit.
 */
import { spawnSync } from 'child_process';
import { getRepoRemote, listRepositories } from './operations.js';

const GH_TIMEOUT_MS = 15_000;
const GH_MAX_BYTES = 5 * 1024 * 1024;

export interface RepoRef {
  name: string;   // workspace folder name
  path: string;   // absolute path
  owner: string;
  repo: string;
}

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  user: string | null;
  url: string;
  updatedAt: string;
  branch: string | null;
  base: string | null;
}

export interface IssueItem {
  number: number;
  title: string;
  state: string;
  user: string | null;
  url: string;
  updatedAt: string;
  comments: number;
  labels: string[];
}

type GhResult<T> = { ok: true; data: T } | { ok: false; error: string };

const isSlug = (s: string): boolean => /^[\w.-]{1,100}$/.test(s);
const normState = (s: unknown): 'open' | 'closed' | 'all' =>
  s === 'closed' || s === 'all' ? s : 'open';

/** Call `gh api <path>` and parse JSON. `path` is built internally from validated slugs. */
function ghApi(path: string): GhResult<any> {
  const res = spawnSync('gh', ['api', path, '-H', 'Accept: application/vnd.github+json'], {
    timeout: GH_TIMEOUT_MS,
    maxBuffer: GH_MAX_BYTES,
    encoding: 'utf8',
  });
  if (res.error) return { ok: false, error: 'gh not available' };
  if (res.status !== 0) {
    const err = (res.stderr || '').toString();
    if (/gh auth login|authentication|HTTP 401/i.test(err)) return { ok: false, error: 'Not authenticated with GitHub' };
    return { ok: false, error: err.slice(0, 300) || 'gh api failed' };
  }
  try {
    return { ok: true, data: JSON.parse(res.stdout || 'null') };
  } catch {
    return { ok: false, error: 'Invalid JSON from gh api' };
  }
}

/** Workspace repos that have a GitHub `origin` remote, resolved to owner/repo. */
export function listGitHubRepos(): RepoRef[] {
  const out: RepoRef[] = [];
  for (const r of listRepositories()) {
    const remote = getRepoRemote(r.path);
    if (remote) out.push({ name: r.name, path: r.path, owner: remote.owner, repo: remote.repo });
  }
  return out;
}

export function listPullRequests(owner: string, repo: string, state?: unknown): GhResult<PullRequest[]> {
  if (!isSlug(owner) || !isSlug(repo)) return { ok: false, error: 'Invalid owner/repo' };
  const r = ghApi(`repos/${owner}/${repo}/pulls?state=${normState(state)}&per_page=30&sort=updated&direction=desc`);
  if (!r.ok) return r;
  const pulls: PullRequest[] = (Array.isArray(r.data) ? r.data : []).map((p: any) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    draft: !!p.draft,
    user: p.user?.login ?? null,
    url: p.html_url,
    updatedAt: p.updated_at,
    branch: p.head?.ref ?? null,
    base: p.base?.ref ?? null,
  }));
  return { ok: true, data: pulls };
}

export function listIssues(owner: string, repo: string, state?: unknown): GhResult<IssueItem[]> {
  if (!isSlug(owner) || !isSlug(repo)) return { ok: false, error: 'Invalid owner/repo' };
  const r = ghApi(`repos/${owner}/${repo}/issues?state=${normState(state)}&per_page=30&sort=updated&direction=desc`);
  if (!r.ok) return r;
  // The issues endpoint also returns PRs — filter those out (they carry pull_request).
  const issues: IssueItem[] = (Array.isArray(r.data) ? r.data : [])
    .filter((i: any) => !i.pull_request)
    .map((i: any) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      user: i.user?.login ?? null,
      url: i.html_url,
      updatedAt: i.updated_at,
      comments: i.comments ?? 0,
      labels: Array.isArray(i.labels) ? i.labels.map((l: any) => (typeof l === 'string' ? l : l.name)).filter(Boolean) : [],
    }));
  return { ok: true, data: issues };
}
