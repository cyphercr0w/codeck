# ORCA Parity — Design & Implementation

**Status:** implemented on `feat/modernization-2026` (build green, not deployed).

[Orca](https://www.onorca.dev/) is a local desktop Agent Development Environment
(worktree-per-task IDE running many CLI agents in parallel). Codeck is a remote
Docker sandbox with a governed autonomous harness. Different axis, but Orca
exposes UX gaps worth closing. This covers the four points picked: **D** usage
widget, **B1** diff-review loop, **C** GitHub PR/issues, **B2** Design Mode.
(Point **A**, worktree-parallel agents, remains on the roadmap.)

## D — Usage / rate-limit widget

**Already built end-to-end** — `services/agent-usage.ts` fetches
`api.anthropic.com/api/oauth/usage` (5h/7d utilization + reset), `/api/dashboard`
serves it, `startUsagePolling` hydrates the `claudeUsage` signal. A finished
`UsageBars` component existed in `Sidebar.tsx` but was **never rendered**.
Change: render `<UsageBars collapsed={collapsed}/>` in the sidebar footer. One line.
Tier and multi-account remain out (not in the token/usage payload; multi-account
contradicts the single-user design).

## B1 — Interactive diff-review loop

The reprompt path is nearly free: the web already writes into a live Claude Code
PTY via `wsSend({ type: "console:input", sessionId, data })`. No diff surface
existed, so it's built new.

- **Backend:** `GET /api/git/diff?cwd=&staged=&base=` → `getGitDiff()` in
  `services/git/operations.ts` (shells `git -C <cwd> diff`, cwd validated within
  workspace, 5 MB cap).
- **Frontend:** the **Changes** tab of the new `ScmSection`. Parses the unified
  diff, lets the user click a changed line to attach a markdown comment, batches
  them, and **Send to agent** compiles the comments into a **single-line** prompt
  (a PTY submits on newline) injected into the chosen agent session via
  `console:input` + `\r`.

## C — GitHub PR/issues in-UI

Codeck already had `services/git/github-auth.ts` + `/api/github` + device-login
UI + the `gh api` shell pattern. Only gap: remote→owner/repo detection.

- **Backend:** `getRepoRemote()` in `operations.ts` (`git remote get-url origin`
  → `{owner,repo}`). New `services/git/github-api.ts` shells `gh api` (reuses the
  keyring, no octokit): `listGitHubRepos()`, `listPullRequests()`, `listIssues()`
  (PRs filtered out of the issues endpoint). Routes on `github.routes.ts`:
  `GET /repos`, `GET /:owner/:repo/pulls`, `GET /:owner/:repo/issues`.
- **Frontend:** the **GitHub** tab of `ScmSection` — repo picker, PR/issue toggle,
  state filter, link-out to GitHub.

**Consolidation:** B1 + C ship as one VSCode-like **Source Control** section
(`ScmSection`, nav `scm`, route `/source-control`) rather than two tabs.

## B2 — Design Mode ("Claude Design")

Orca's Design Mode lets you click a rendered element and feed its HTML/CSS to the
agent. Codeck's live **Agent Browser** (`playwright-screencast.ts`, a CDP Chrome
on 9222 rendered by `PlaywrightPreview`) is the substrate.

- **Backend:** `inspectElementAt(x,y)` in `playwright-screencast.ts` uses the
  existing CDP connection — `DOM.getNodeForLocation` → `DOM.getOuterHTML` +
  `DOM.describeNode` → `{ tag, selector, outerHTML, url }` (outerHTML collapsed to
  one line, truncated). Route: `POST /api/preview/playwright/inspect {x,y}`.
- **Frontend:** a **Design** toggle on `PlaywrightPreview`. In design mode a click
  maps the on-screen position into the frame's natural pixel space, POSTs to
  `/inspect`, drops a pin, and shows the resolved selector + a note box.
  **Send to agent** builds a single-line design-feedback prompt (selector +
  outerHTML snippet + note) injected via `console:input` into the active agent
  session. Falls back to the click position if no element resolves.

**Runtime caveat:** the CDP coordinate mapping and `getNodeForLocation` path can't
be exercised without the container (Docker). Verify Design Mode end-to-end in a
running sandbox — the pixel mapping assumes the screencast frame ≈ the 1280×720
viewport (true for the current launch flags).

## Files

- Backend: `services/git/operations.ts` (`getGitDiff`, `getRepoRemote`),
  `services/git/github-api.ts` (new), `services/git.ts` (re-exports),
  `services/playwright-screencast.ts` (`inspectElementAt`),
  `routes/git.routes.ts`, `routes/github.routes.ts`, `routes/preview.routes.ts`.
- Frontend: `components/ScmSection.tsx` (new), `components/PlaywrightPreview.tsx`
  (Design Mode), `components/Sidebar.tsx` (UsageBars + scm icon),
  `components/MobileMenu.tsx` (scm icon), `state/store.ts` (`scm` section),
  `components/nav-items.ts`, `router.ts`, `app.tsx`.

## Monaco IDE (shipped)

`EditorSection` replaces the plain-textarea file browser in the `filesystem`
section (now reachable in nav as "Editor"): a lazy file tree + tab bar + Monaco
editor (one model per file, dirty state, Ctrl+S → `PUT /api/files/write`).
`monaco-editor` is loaded via a dynamic `import("../monaco-setup")` so it and its
`?worker` chunks are on-demand — the main bundle is unchanged; the Monaco chunk
(~3.3 MB, 857 KB gz) and language workers load only when the Editor is opened.
`src/vite-env.d.ts` provides the `?worker` types.

## Not done (deliberately)

- **A — worktree-parallel agents** (Orca's core): the biggest lift, on the
  roadmap; codeck stays read-parallel/write-serial for now.
- Creating PRs/issues, GitHub Projects boards (Projects v2 GraphQL): phase 2.
- Editor niceties still open: search-in-files, split view, per-tab language
  override, format-on-save.
