# Frontend Architecture — Codeck Sandbox

## Stack

| Technology | Version | Purpose |
|-----------|---------|---------|
| Preact | 10.19 | Virtual DOM (3KB), React-compatible API |
| @preact/signals | 1.2 | Reactive state management |
| xterm.js | 5.5 | Terminal emulator in the browser |
| xterm-addon-fit | 0.10 | Auto-resize terminal to container |
| Vite | 5.4 | Bundler, dev server, HMR |
| TypeScript | 5.3 | Type checking (noEmit, Vite transpiles) |

## Build

- **Dev:** `vite dev` with proxy to Express backend (`/api` → HTTP, `/ws` → WebSocket)
- **Prod:** `vite build` → output to `apps/web/dist/`, served by Express static middleware
- **TSConfig:** `jsxImportSource: "preact"`, `moduleResolution: "bundler"`, `strict: true`

---

## URL Routing

Lightweight History API routing — no router library. `router.ts` syncs `activeSection` signal with the browser URL.

| URL | Section |
|-----|---------|
| `/` | home |
| `/files` | filesystem |
| `/terminal` | claude |
| `/agents` | agents |
| `/integrations` | integrations |
| `/config` | config |
| `/settings` | settings |

- **Deep linking**: Direct URL access loads the correct section
- **Back/forward**: `popstate` listener updates `activeSection`
- **Signal → URL**: `useEffect` in `app.tsx` calls `pushSection()` on changes
- **SPA catch-all**: Express serves `index.html` for all non-API GET routes

## File Structure

```
apps/web/
├── index.html              # Vite entry point (loads Inter + JetBrains Mono fonts)
├── vite.config.ts          # Build config + dev proxy
├── tsconfig.json           # Frontend-only TS config
└── src/
    ├── main.tsx            # App bootstrap: render(<App />, #app)
    ├── app.tsx             # Root component, view lifecycle manager
    ├── router.ts           # URL ↔ section sync (History API)
    ├── api.ts              # Fetch wrapper with auth + 401 handling
    ├── ws.ts               # WebSocket client with auto-reconnect
    ├── terminal.ts         # xterm.js instance manager
    ├── state/
    │   └── store.ts        # All signals + mutation functions
    ├── components/
    │   ├── Icons.tsx                  # Centralized SVG icon library (40+ icons)
    │   ├── AuthView.tsx              # Password setup/login
    │   ├── LoadingView.tsx           # Branded loading (bridge icon + pulse)
    │   ├── SetupView.tsx             # Claude account connection prompt
    │   ├── PresetWizard.tsx          # Preset selection (post-auth)
    │   ├── LoginModal.tsx            # OAuth PKCE flow modal
    │   ├── Sidebar.tsx               # Navigation + collapse/expand
    │   ├── HomeSection.tsx           # Dashboard: account, resources, usage
    │   ├── FilesSection.tsx          # Workspace file browser
    │   ├── ClaudeSection.tsx         # Terminal tabs + xterm.js
    │   ├── AgentsSection.tsx         # Proactive agents (list, create, edit, detail, live output)
    │   ├── AgentConfigSection.tsx    # .codeck file browser/editor
    │   ├── IntegrationsSection.tsx   # SSH keys + GitHub + third-party CLI auth
    │   ├── SettingsSection.tsx       # Password, sessions, permissions, logs, ports
    │   ├── ToastContainer.tsx        # Toast notification system
    │   ├── SubagentPanel.tsx         # Real-time sub-agent tracking panel
    │   ├── NewProjectModal.tsx       # Create/clone/select project
    │   ├── ReconnectOverlay.tsx      # Full-screen WS disconnect overlay
    │   ├── MobileTerminalToolbar.tsx # Adaptive mobile terminal toolbar
    │   ├── ConfirmModal.tsx          # Reusable confirmation dialog
    │   ├── MobileMenu.tsx            # Mobile navigation overlay
    │   ├── ImageUploadOverlay.tsx    # Image upload overlay
    │   ├── UploadOverlay.tsx         # File upload overlay
    │   └── PullToRefresh.tsx         # Mobile pull-to-refresh
    └── styles/
        ├── variables.css       # CSS custom properties (design tokens)
        ├── global.css          # Reset, buttons, inputs, badges, modals
        └── app.css             # All component-specific styles
```

---

## View Lifecycle

```
loading → auth → setup → preset → main
```

| View | Component | Condition |
|------|-----------|-----------|
| `loading` | `LoadingView` | Initial state while checking auth |
| `auth` | `AuthView` | Password not configured or not logged in |
| `setup` | `SetupView` + `LoginModal` | Password OK but Claude not authenticated |
| `preset` | `PresetWizard` | Claude authenticated but no preset applied |
| `main` | Sidebar + sections | Fully authenticated and configured |

### Initialization flow (App.tsx)

1. `GET /api/auth/status` → is password configured?
2. If no → `view='auth'`, `authMode='setup'`
3. If yes → check localStorage for token
4. If no token → `view='auth'`, `authMode='login'`
5. If token → `GET /api/status` to validate
6. If 401 → clear token, `view='auth'`
7. If OK → `updateStateFromServer(data)`
   - If preset not configured → `view='preset'`
   - If Claude authenticated → `view='main'`, connect WS, restore sessions
   - If Claude not auth → `view='setup'`, connect WS
8. On network error → retry with exponential backoff (1s → 30s cap)

---

## State Management (Signals)

All state in `state/store.ts` as Preact signals.

### Key Signals

| Signal | Type | Default | Description |
|--------|------|---------|-------------|
| `view` | `View` | `'loading'` | Current view |
| `activeSection` | `Section` | `'home'` | Active section (home\|filesystem\|claude\|agents\|integrations\|config\|settings) |
| `authMode` | `AuthMode` | `'login'` | Auth view mode |
| `claudeAuthenticated` | `boolean` | `false` | Claude account connected |
| `accountEmail` | `string \| null` | `null` | User email |
| `sessions` | `TerminalSession[]` | `[]` | Active PTY sessions |
| `activeSessionId` | `string \| null` | `null` | Focused session |
| `sessionStatus` | `Record<string, SessionStatus>` | `{}` | Per-session status (active/idle/waiting/exited) |
| `wsConnected` | `boolean` | `false` | WebSocket connected |
| `restoringPending` | `boolean` | `false` | Session restore in progress |
| `logs` | `LogEntry[]` | `[]` | Log entries (max 1000) |
| `presetConfigured` | `boolean` | `false` | Preset applied |
| `activePorts` | `PortInfo[]` | `[]` | Listening ports with exposure status |
| `isMobile` | `boolean` | `detectMobile()` | Feature-based mobile detection |
| `mobileKeyboardOpen` | `boolean` | `false` | Mobile keyboard state |
| `activeSubagents` | `SubagentInfo[]` | `[]` | Active sub-agents |
| `toasts` | `Toast[]` | `[]` | Toast notification queue |

### Derived signals

- `activeSession` — computed from `sessions` + `activeSessionId`
- `sessionCount` — computed from `sessions.length`

### Mutation functions

| Function | Description |
|----------|-------------|
| `updateStateFromServer(data)` | Hydrate signals from server status response |
| `addLog(entry)` / `clearLogs()` | Log management |
| `addSession(s)` / `removeSession(id)` / `renameSession(id, name)` | Session management |
| `replaceSession(oldId, newSession)` | Replace placeholder with real session |
| `setSessionStatus(id, status)` / `clearSessionStatus(id)` | Session status tracking |
| `showToast(message, type)` / `dismissToast(id)` | Toast notifications |

---

## Components

### `App.tsx` — Root Component

Manages entire app lifecycle. Uses AbortController for cleanup.
- Exponential backoff for init retries: 1s → 30s cap, max 5 retries
- ErrorBoundary wraps all section content
- Placeholder sessions (temp ID) while creating, replaced with real ID on API response
- Session limit: max 5 (SESSION_LIMIT constant)

### `AuthView.tsx` — Password Auth

Two modes: `setup` (create + confirm) and `login`. Uses direct `fetch()` (no token yet).

### `SetupView.tsx` — Claude Connection Prompt

Minimal card with "Connect Claude Account" button → triggers LoginModal.

### `PresetWizard.tsx` — Preset Selection

Grid of preset cards from `/api/presets` with icon, name, description, recommended badge.

### `LoginModal.tsx` — OAuth PKCE Flow

Step-by-step: calls login → polls status every 1.5s → user copies code → submits code. `cleanAuthCode()` strips accidental extra text.

### `Sidebar.tsx` — Navigation

7 nav items: Home, Filesystem, Terminal, Auto Agents, Integrations, Config, Settings. SVG icons, green/red status dot, version footer. Desktop: collapse/expand (56px / 260px). Mobile: overlay with backdrop.

### `HomeSection.tsx` — Dashboard

- Account info cards (email, org, sessions)
- Container resources: CPU, Memory, Disk bars (color-coded)
- Claude usage: 5-hour and 7-day utilization bars
- Model selector (sonnet/opus/haiku)
- Port mapping card (bridge mode): shows ports, add/remove
- Workspace export button

### `FilesSection.tsx` — File Browser

Directory navigation of `/workspace` with breadcrumbs, list view, file viewer/editor. Uses `currentFilesPath` signal for persistent navigation.

### `ClaudeSection.tsx` — Terminal Manager

Multi-tab terminal interface:
- Tab bar with session tabs (double-click rename, X to close)
- Session status indicators per tab (active/idle/waiting/exited)
- "+" button for new session (max 5)
- Terminal containers with xterm.js
- Browser notifications on session exit (if tab hidden)
- Stabilization retries (`attachSettleRepaint`) on WS reconnect

### `AgentsSection.tsx` — Proactive Agents

Agent list (dash-card grid), create/edit modals with directory selector, agent detail with expand/collapse, live streaming output, run now button, execution history.

### `IntegrationsSection.tsx` — External Services

- **SSH:** Generate key, copy public key, link to GitHub settings
- **GitHub CLI:** Device flow login with code display and polling
- **Third-party CLI auth:** Vercel and other services via device flow

### `SettingsSection.tsx` — Settings

Replaces the old separate ConfigSection concerns. Contains multiple cards:
- **Change Password:** Current + new + confirm form
- **Active Sessions:** Grouped by IP, revoke individual or per-IP
- **Permissions:** Tool permissions (Read/Edit/Write/Bash/WebFetch/WebSearch) + MCP server permissions
- **Logs:** Inline log viewer with colored indicators and clear button
- **Port Mapping:** Port list with add/remove (bridge mode)

### `AgentConfigSection.tsx` — Config Editor

File browser for `.codeck/` directory with breadcrumbs, read/edit mode, save, reset to defaults with confirmation.

### `ToastContainer.tsx` — Toast Notifications

Fixed-position toast container. Renders from `toasts` signal. Auto-dismiss timer. Types: success, error, info.

### `SubagentPanel.tsx` — Sub-Agent Tracking

Real-time panel showing active Claude Code sub-agents:
- Agent type icons (Explore, Plan, code-reviewer, etc.)
- Elapsed time display
- Status text from last message or line
- Collapse/expand

### `NewProjectModal.tsx` — Project Creation

Three-tab modal: existing folder, new folder, clone repo. Resume conversation checkbox.

### `ReconnectOverlay.tsx` — Reconnection UI

Full-screen overlay on WS disconnect. Spinner + "Reconnecting..." with backdrop blur. Also shown during session restore (`restoringPending` signal).

### `MobileTerminalToolbar.tsx` — Mobile Controls

Adaptive toolbar:
- **Default mode**: Navigation keys + shortcuts (Ctrl+C, Ctrl+U, etc.)
- **Y/N mode**: Large buttons when terminal shows `(y/n)` patterns
- Event-driven detection via `onTerminalWrite` subscription
- Hidden input with sentinel character for native keyboard capture
- Collapsible with localStorage persistence

### `ConfirmModal.tsx` — Confirmation Dialog

Reusable modal for destructive actions.

### `MobileMenu.tsx` — Mobile Navigation

Slide-down overlay with 7 nav items and connection status.

---

## Terminal System (`terminal.ts`)

Manages xterm.js instances in a `Map<string, TerminalInstance>`.

### Configuration

```typescript
{
  theme: { background: '#0a0a0b', foreground: '#fafafa', cursor: '#6366f1' },
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  fontSize: 14,       // 12 on mobile
  cursorBlink: true,
  scrollback: 5000,
  convertEol: true
}
```

### Mobile detection

Feature-based (pointer: coarse + touch + screen < 1100px):
- Font size: 14px → 12px
- Resize debounce: 50ms → 200ms
- Disables autocomplete/autocorrect on xterm textarea

### Instance lifecycle

1. `createTerminal(sessionId, container)` — creates Terminal + FitAddon
2. ResizeObserver triggers `fitAddon.fit()` + sends `console:resize` via WS
3. `onData` sends keystrokes via `wsSend({type: 'console:input'})`
4. `destroyTerminal(sessionId)` — disposes terminal + observer

### Mobile scroll lock

Prevents xterm's auto-scroll from yanking user back to bottom while reading history:
1. Viewport scroll listener detects user not at bottom
2. Sets `scrollLocked` for that session
3. When locked, saves/restores scrollTop around `term.write()`
4. Lock clears when user scrolls to bottom

---

## API Client (`api.ts`)

```typescript
apiFetch(url, options)
  → Adds 'Authorization: Bearer <token>'
  → Adds 'Content-Type: application/json'
  → On 401: clearAuthToken(), view='auth', throw error
```

Token stored in `localStorage` key `codeck_auth_token`.

---

## WebSocket Client (`ws.ts`)

### Connection

- `ws://host?token=<token>` (or `wss://` for HTTPS)
- Auto-reconnect: exponential backoff 1s → 30s, 50-100% jitter, max 15 attempts
- Stale connection detector: checks every 10s, force-closes if no data for 45s
- Buffered resize: buffers latest resize during disconnect, sends on reconnect

### Message Handling

- All messages validated against known type set
- `status` message syncs session list and re-attaches all sessions
- `console:error` removes ghost sessions
- Handlers: status, log, logs, ports, sessions:restored, console:output, console:exit, agent:*, subagent:*

---

## CSS Architecture

### Design tokens (`variables.css`)

Dark-only theme with indigo accent:
- Backgrounds: `#0a0a0b` → `#2a2a30` (6 levels)
- Text: `#fafafa` → `#606068` (3 levels)
- Accent: `#6366f1` (indigo)
- Status: green/yellow/red with subtle variants
- Fonts: `--font-sans` (Inter), `--font-mono` (JetBrains Mono)
- Layout: `--sidebar-width: 260px`, `--sidebar-collapsed-width: 56px`

### Organization

- `global.css` — Reset, buttons, inputs, badges, modals
- `app.css` — All component styles with section comments
- All icons are inline SVGs from `Icons.tsx`
- Responsive breakpoints at 1100px, 700px, 600px
- Mobile (below 700px): hamburger on LEFT, logo+title on RIGHT

### Font loading

Google Fonts CDN: Inter (400-700) and JetBrains Mono (400-700). Preconnect hints, preload, `font-display: swap`.

---

## Accessibility

Codeck targets WCAG 2.1 Level AA:

### Implemented

- ARIA dialog pattern on all modals
- Semantic landmarks (`<header>`, `<main>`, `<aside>`, `<nav>`)
- Focus indicators on all interactive elements
- ARIA labels on icon-only buttons, `aria-current="page"` on nav
- Live regions: `role="log"`, `role="alert"`, `role="status"`
- `@media (prefers-reduced-motion: reduce)` disables animations

### Known limitations

- xterm.js has limited screen reader support
- Full heading hierarchy not yet implemented
- Color contrast not validated with automated tooling
