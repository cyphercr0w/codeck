# Plan: Integrations Refactor + Real-Time GitHub Auth Detection

## Problem

1. **GitHub login detection is not real-time**: `gh auth login --web` completes in the container but the frontend doesn't know until F5. The current polling (`pollGitHubLogin`) polls `/api/github/login-status` every 2s, but `ghLoginState` doesn't update properly after `gh auth login` completes outside the UI flow (e.g., from terminal).
2. **Integrations page is flat**: GitHub SSH + GitHub Account are cards on a single page. No room for future integrations without visual clutter.

## Architecture Changes

### Part 1: Real-Time GitHub Auth via WebSocket

**Backend** — `src/routes/github.routes.ts`:
- `onSuccess` callback already calls `broadcastStatus()` — this sends a full status update via WS
- Problem: `broadcastStatus()` sends general app status, but the frontend WS handler doesn't trigger a re-fetch of GitHub-specific status
- Fix: Add a dedicated WS message type `github:auth-changed` that the frontend listens for

**Backend** — `src/web/websocket.ts`:
- Add `broadcastGitHubAuth(authenticated: boolean)` that sends `{ type: 'github:auth-changed', authenticated: true }` to all connected clients
- Export it for use in `github.routes.ts`

**Backend** — `src/routes/github.routes.ts`:
- In `onSuccess` callback: call `broadcastGitHubAuth(true)` instead of just `broadcastStatus()`
- In `onError` callback: call `broadcastGitHubAuth(false)`
- Also reset `ghLoginState.success` after it's been read once (prevent stale state — Known Issue #8)

**Frontend** — `src/web/src/ws.ts`:
- Add handler for `github:auth-changed` message type
- Expose a signal or event that components can subscribe to: `githubAuthChanged = signal<boolean | null>(null)`

**Frontend** — `src/web/src/components/IntegrationsSection.tsx` (or the new GitHub sub-page):
- Subscribe to `githubAuthChanged` signal
- When it fires with `true`, update GitHub state to authenticated without needing to poll or refresh
- Remove the `pollGitHubLogin()` interval (Known Issue #9 — polling leak)

### Part 2: Integrations Sub-Page Architecture

**Current structure:**
```
Integrations (single flat page)
  ├── GitHub SSH card
  ├── GitHub Account card
  └── "More integrations" placeholder
```

**New structure:**
```
Integrations (hub page — grid of integration cards)
  ├── GitHub card (click → GitHub sub-page)
  ├── GitLab card (future, disabled/placeholder)
  ├── Docker Hub card (future, disabled/placeholder)
  └── ... more integrations

GitHub sub-page (detail view)
  ├── Back button → Integrations
  ├── Account section (gh auth — connect/disconnect)
  └── SSH Keys section (generate/copy/delete)
```

**State** — `src/web/src/state/store.ts`:
- Add `integrationSubPage = signal<string | null>(null)` (null = hub, 'github' = GitHub detail)
- Or simpler: use a local state in IntegrationsSection

**Components:**

| File | Change |
|------|--------|
| `src/web/src/components/IntegrationsSection.tsx` | Refactor to hub page — grid of clickable integration cards. Render sub-page when selected. |
| `src/web/src/components/integrations/GitHubIntegration.tsx` | **NEW** — Extract current GitHub SSH + Account cards into this component. Add back button. Subscribe to `github:auth-changed` WS event. |

**No new routes needed** — all API endpoints already exist (`/api/github/*`, `/api/ssh/*`).

### Part 3: Fix Known Issues

While refactoring, fix these related issues:

- **#8 — ghLoginState.success never resets**: Reset after successful read or after timeout
- **#9 — pollGitHubLogin interval leak**: Replace polling with WS subscription, remove interval entirely
- **#7 — isGhAuthenticated() not cached**: Cache result for 30s in `git.ts`

## Files to Modify

| File | Type | Description |
|------|------|-------------|
| `src/web/websocket.ts` | MODIFY | Add `broadcastGitHubAuth()` export |
| `src/routes/github.routes.ts` | MODIFY | Use `broadcastGitHubAuth()`, reset stale state |
| `src/services/git.ts` | MODIFY | Cache `isGhAuthenticated()` for 30s |
| `src/web/src/ws.ts` | MODIFY | Handle `github:auth-changed` message, expose signal |
| `src/web/src/state/store.ts` | MODIFY | Add `githubAuthenticated` signal (optional) |
| `src/web/src/components/IntegrationsSection.tsx` | REWRITE | Hub page with card grid + sub-page routing |
| `src/web/src/components/integrations/GitHubIntegration.tsx` | NEW | GitHub detail sub-page (account + SSH) |
| `src/web/src/styles/app.css` | MODIFY | Integration hub grid styles, sub-page transition |
| `docs/FRONTEND.md` | MODIFY | Update component docs |
| `docs/API.md` | MODIFY | Document `github:auth-changed` WS message |
| `docs/KNOWN-ISSUES.md` | MODIFY | Mark #7, #8, #9 as resolved |

## Implementation Order

1. Backend: `broadcastGitHubAuth()` in websocket.ts + github.routes.ts
2. Backend: Cache `isGhAuthenticated()` in git.ts
3. Frontend: WS handler for `github:auth-changed` in ws.ts
4. Frontend: Extract `GitHubIntegration.tsx` from IntegrationsSection
5. Frontend: Rewrite `IntegrationsSection.tsx` as hub with sub-page routing
6. CSS: Hub grid + sub-page styles
7. Docs update

## Prompt for Implementation

```
Implement the Integrations refactor as described in docs/PLAN-integrations-refactor.md.

Summary:
1. Add `broadcastGitHubAuth(authenticated)` to websocket.ts — sends `{ type: 'github:auth-changed', authenticated }` to all WS clients
2. In github.routes.ts, call `broadcastGitHubAuth(true)` on login success, reset ghLoginState properly
3. Cache `isGhAuthenticated()` in git.ts (30s TTL) to avoid spawning `gh auth status` on every status call
4. In frontend ws.ts, handle `github:auth-changed` message and expose a signal
5. Extract GitHub-specific UI from IntegrationsSection.tsx into a new `integrations/GitHubIntegration.tsx` component
6. Rewrite IntegrationsSection.tsx as a hub page with a grid of integration cards — clicking GitHub opens the detail sub-page
7. In GitHubIntegration.tsx, subscribe to the WS signal instead of using pollGitHubLogin() — delete the polling interval entirely
8. Update docs: FRONTEND.md, API.md, KNOWN-ISSUES.md (mark #7, #8, #9 as resolved)

Follow existing code patterns. No new npm dependencies. Update docs in the same commit.
```
