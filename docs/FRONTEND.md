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

- **Dev:** `vite dev` with proxy to Express at `:8080` (`/api` → HTTP, `/ws` → WebSocket)
- **Prod:** `vite build` → output to `apps/web/dist/`, served by runtime (local mode) or daemon (gateway mode) static middleware
- **TSConfig:** `jsxImportSource: "preact"`, `moduleResolution: "bundler"`, `strict: true`

---

## URL Routing

Lightweight History API routing — no router library. The signal architecture stays as-is; `router.ts` syncs `activeSection` signal with the browser URL.

| URL | Section |
|-----|---------|
| `/` | home |
| `/files` | filesystem |
| `/terminal` | claude |
| `/agents` | agents |
| `/integrations` | integrations |
| `/config` | config |

- **Deep linking**: Direct URL access (e.g., `/terminal`) loads the correct section on init
- **Back/forward**: `popstate` listener updates `activeSection` signal
- **Signal → URL**: `useEffect` in `app.tsx` calls `pushSection()` on section changes
- **SPA catch-all**: Express serves `index.html` for all non-API GET routes

## File Structure

```
src/web/
├── index.html              # Vite entry point (loads Inter + JetBrains Mono fonts)
├── vite.config.ts          # Build config + dev proxy
├── tsconfig.json           # Frontend-only TS config
└── src/
    ├── main.tsx            # App bootstrap: render(<App />, #app)
    ├── app.tsx             # Root component, view lifecycle manager
    ├── router.ts           # URL ↔ section sync (History API, no library)
    ├── api.ts              # Fetch wrapper with auth + 401 handling
    ├── ws.ts               # WebSocket client with auto-reconnect
    ├── terminal.ts         # xterm.js instance manager
    ├── state/
    │   └── store.ts        # All signals + mutation functions
    ├── components/
    │   ├── Icons.tsx            # Centralized SVG icon library (40+ icons)
    │   ├── AuthView.tsx        # Password setup/login
    │   ├── LoadingView.tsx     # Branded loading (bridge icon + pulse)
    │   ├── SetupView.tsx       # Claude account connection prompt
    │   ├── PresetWizard.tsx    # Preset selection (post-auth)
    │   ├── LoginModal.tsx      # OAuth PKCE flow modal
    │   ├── Sidebar.tsx         # Navigation with SVG icons + version footer + collapse/expand
    │   ├── HomeSection.tsx     # Dashboard: account, resources, usage
    │   ├── FilesSection.tsx    # Workspace file browser with edit capability
    │   ├── ClaudeSection.tsx   # Terminal tabs + xterm.js
    │   ├── MemorySection.tsx       # Memory system (durable, journal, ADR, projects, search)
    │   ├── AgentsSection.tsx      # Proactive agents (list, create, edit, detail, dir selector, live streaming output; Run Now button disabled for paused/running agents)
    │   ├── IntegrationsSection.tsx  # SSH keys + GitHub CLI auth
    │   ├── ConfigSection.tsx   # .codeck file browser/editor
    │   ├── LogsDrawer.tsx      # Bottom log panel with colored indicators
    │   ├── NewProjectModal.tsx # Create/clone/select project
    │   ├── ReconnectOverlay.tsx # Full-screen overlay when WebSocket disconnected
    │   ├── MobileTerminalToolbar.tsx # Adaptive mobile terminal toolbar with Y/N detection
    │   ├── ConfirmModal.tsx    # Reusable confirmation dialog
    │   └── MobileMenu.tsx      # Mobile navigation overlay
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

All state lives in `state/store.ts` as Preact signals.

### Signals

| Signal | Type | Default | Description |
|--------|------|---------|-------------|
| `view` | `View` | `'loading'` | Current view |
| `activeSection` | `Section` | `'home'` | Active main section (home\|filesystem\|claude\|agents\|integrations\|config) |
| `authMode` | `AuthMode` | `'login'` | Auth view mode |
| `claudeAuthenticated` | `boolean` | `false` | Claude account connected |
| `accountEmail` | `string` | `''` | User email |
| `accountOrg` | `string` | `''` | Organization name |
| `accountUuid` | `string` | `''` | Account UUID |
| `sessions` | `TerminalSession[]` | `[]` | Active PTY sessions |
| `activeSessionId` | `string` | `''` | Currently focused session |
| `wsConnected` | `boolean` | `false` | WebSocket connected |
| `logs` | `LogEntry[]` | `[]` | Log entries |
| `logsExpanded` | `boolean` | `false` | Logs drawer open |
| `presetConfigured` | `boolean` | `false` | Preset applied |
| `currentFilesPath` | `string` | `''` | Files section current path |
| `activePorts` | `PortInfo[]` | `[]` | Listening ports with exposure status (`{port, exposed}`) |
| `isMobile` | `boolean` | `detectMobile()` | Feature-based mobile detection (pointer: coarse + touch + screen < 1100px) |

### Mutation functions

| Function | Description |
|----------|-------------|
| `updateStateFromServer(data)` | Hydrate signals from server status response |
| `addLog(entry)` | Append log entry |
| `addLocalLog(type, msg)` | Create and append a log entry |
| `clearLogs()` | Empty logs array |
| `addSession(s)` | Add session, set as active |
| `replaceSession(oldId, newSession)` | Replace placeholder session with real one |
| `renameSession(id, name)` | Update session name |
| `removeSession(id)` | Remove session, switch active to last remaining |

---

## Components

### `App.tsx` — Root Component

Manages entire app lifecycle. Local state mirrors signals for reliable re-renders.

**Key behaviors:**
- Calls `initializeApp()` on mount with AbortController (cleanup on unmount prevents memory leaks)
- Exponential backoff for initialization retries: 1s → 2s → 4s → 8s → 16s (capped at 30s), max 5 retries
- ErrorBoundary wraps all section content (line 393) — catches errors in declarative code (render, lifecycle) but NOT async/event handlers (sections handle those with try/catch)
- Handles transitions between views
- Creates terminal sessions via `handleProjectConfirm()`
- Uses placeholder sessions (temp ID) while creating, replaced with real ID on API response
- Session limit: max 5 sessions (SESSION_LIMIT constant), shows warning when limit reached

### `AuthView.tsx` — Password Auth

Two modes: `setup` (create password + confirm) and `login` (enter password).
Uses direct `fetch()` (not `apiFetch()`) since user has no token yet.

### `SetupView.tsx` — Claude Connection Prompt

Minimal card with "Connect Claude Account" button. Triggers `LoginModal` opening.

### `PresetWizard.tsx` — Preset Selection

Grid of preset cards fetched from `/api/presets`. Each card shows icon, name, description, and "Recommended" badge. Clicking "Configure" applies the preset.

### `LoginModal.tsx` — OAuth PKCE Flow

Step-by-step OAuth flow:
1. Calls `/api/claude/login` to get OAuth URL
2. Polls `/api/claude/login-status` every 1.5s (max 120 polls)
3. User opens URL, authorizes, copies code
4. User pastes code → `/api/claude/login-code`
5. `cleanAuthCode()` strips accidental extra text from pasted codes

### `Sidebar.tsx` — Navigation

6 nav items: Home, Filesystem, Terminal, Auto Agents, Integrations, Config — each with SVG icons.
Shows green/red connection status dot. Version footer (v0.1). Responsive: mobile overlay with backdrop.
Desktop mode supports collapse/expand with chevron buttons (collapsed width: 56px, full width: 260px).

**Memory section note**: The Memory section now displays tabs as Durable, Daily, Decisions, Paths, Search (no longer Journal/Projects).

### `HomeSection.tsx` — Dashboard

- Account info cards (email, org, status, sessions)
- Container resources: CPU, Memory, Disk progress bars (color-coded: green < 60%, yellow < 80%, red >= 80%)
- Claude usage: 5-hour and 7-day window utilization bars
- Permissions: "Select All" toggle + 6 individual checkboxes (Read, Edit, Write, Bash, WebFetch, WebSearch), all ON by default. Each toggle POSTs immediately.
- Port Mapping card (bridge mode only): shows mapped ports, input to add new ports. Calls `POST /api/system/add-port` which auto-restarts the container. Shows status messages (success, restarting, error).
- Workspace export button (downloads `.tar.gz`)
- Auto-refreshes dashboard every 30 seconds (permissions and network info loaded once on mount)

### `Icons.tsx` — SVG Icon Library

Centralized icon components replacing all emojis across the app. 40+ inline SVG icons (24x24 viewBox, stroke-based, 1.5px stroke). Includes `getFileIcon(name, size)` helper that maps file extensions to the appropriate icon component. Icons include navigation, file types, status indicators, and actions.

### `FilesSection.tsx` — File Browser

Directory navigation of `/workspace` with breadcrumb path, list view, and built-in file viewer/editor. Click a file to read it, click Edit to modify, Save writes via `PUT /api/files/write`. Uses `currentFilesPath` signal for persistent navigation. Shares file list/row styles with ConfigSection.

### `ClaudeSection.tsx` — Terminal Manager

Multi-tab terminal interface:
- Tab bar with session tabs (double-click to rename, X to close)
- "+" button to add new session (max 5)
- Terminal containers with xterm.js instances
- Browser notifications on session exit (if tab hidden)

**Stabilization retries** (`attachSettleRepaint`): after a WS reconnect settles, `fitTerminal` + `repaintTerminal` are retried at `[500, 1500]` ms as a safety net for cases where the container was hidden or had estimated dimensions during initial settle. `repaintTerminal` is skipped if the mobile hidden input is active (`document.activeElement?.id === 'mobile-hidden-input'`) — the micro-resize+full-refresh causes reflow freeze during typing.

**Exported functions** (outside component):
- `mountTerminalForSession(id, cwd, name)` — creates DOM element, xterm instance, attaches to PTY via WS
- `restoreSessions()` — fetches existing sessions from API and re-mounts terminals

### `IntegrationsSection.tsx` — External Services

Two integration cards:
- **SSH:** Generate key, copy public key, link to GitHub settings
- **GitHub CLI:** Device flow login with code display and polling

### `MemorySection.tsx` — Memory Management

Tabbed interface for the memory system with 5 tabs:
- **Durable** — Read/edit MEMORY.md (rendered pre + edit mode), path-scoped memory support
- **Daily** — Date-based list + today's content + "Add entry" form (with tags), supports path-scoped entries
- **Decisions** — ADR list + click to expand + "New ADR" form, uses filename-based navigation (not numeric IDs), displays `ADR-YYYYMMDD-<slug>.md` format
- **Paths** — Path-scoped memory: list registered paths, view/edit path labels, navigate to path-scoped durable/daily/decisions
- **Search** — FTS5 full-text search with debounced input, scope filter pills (durable/daily/decision/session), path filtering, highlighted snippets, type badges

### Key changes from legacy:
- **Journal → Daily**: Tab renamed, endpoints updated to use `/daily` instead of `/journal`
- **Projects → Paths**: Tab renamed to reflect path-scoped memory (SHA-256 hash-based pathId)
- **ADR naming**: Decisions use `ADR-YYYYMMDD-<slug>.md` format instead of `NNN-title.md`
- **Promote interface**: Richer promote dialog with sourceRef, targetScope, target (durable|adr), section, tags
- **Path scoping**: UI supports filtering memory by pathId throughout all tabs

### `ConfigSection.tsx` — Config Editor

File browser for `.codeck/` directory:
- Breadcrumb navigation
- File icons by type
- Read-only view with toggle to edit mode
- Save button for edited content
- "Reset to defaults" with confirmation dialog

### `LogsDrawer.tsx` — Log Panel

Collapsible bottom drawer:
- Shows log count badge
- Auto-scrolls to latest entry
- Colored dot indicators by log type (info/error)
- Chevron toggle icons
- Clear button
- Content rendered via `dangerouslySetInnerHTML` (relies on backend sanitization from services/logger.ts and proactive-agents/index.ts)

### `MobileTerminalToolbar.tsx` — Mobile Terminal Controls

Adaptive toolbar for mobile terminal interaction:
- **Default mode**: Navigation keys (arrows, Enter, Tab, Esc) + shortcuts (^C, ^U, ^D, ^L, ^A, ^E, ^R, ^W, ^V)
- **Y/N mode**: Large Y/N buttons when terminal buffer contains prompt patterns like `(y/n)`, `[Y/n]`, `[y/N]`
- Event-driven Y/N detection via `onTerminalWrite` subscription (real-time, not polling)
- Unified Pointer Events API for touch/mouse/stylus input
- Hidden input field captures native keyboard with sentinel character (`\u200B`) that keeps the backspace event firing even on empty input
- Collapsible with localStorage persistence
- Visual feedback popup for key actions
- **Debounced `fitTerminal`**: a module-level `debouncedFitTerminal` (350ms) ensures all overlapping `recalcLayout` calls collapse into a single `fitAddon.fit()` call after layout settles — prevents reflow thrashing during keyboard animation
- `onFocus` does NOT schedule `recalcLayout` timers; `visualViewport.resize` handles keyboard-open layout with its own debounce, making the `onFocus` timers redundant and a source of main-thread stall during typing

### `ConfirmModal.tsx` — Confirmation Dialog

Reusable modal for user confirmations:
- Props: `visible`, `title`, `message`, `confirmLabel`, `cancelLabel`, `onConfirm`, `onCancel`
- Used for destructive actions (e.g., config reset, agent deletion)
- Consistent styling with global modal overlay and buttons

### `MobileMenu.tsx` — Mobile Navigation

Slide-down navigation menu for mobile:
- Backdrop overlay with close-on-click
- 6 nav items: Home, Filesystem, Terminal, Auto Agents, Integrations, Config (no Memory item)
- Connection status indicator at bottom
- Automatically closes on section selection

### `NewProjectModal.tsx` — Project Creation

Three-tab modal:
1. **Existing folder** — select from workspace directories, check for resumable conversations
2. **New folder** — name input with path preview
3. **Clone** — URL input, optional name/branch, SSH URL warning

Launch options: "Resume previous conversation" checkbox (existing tab only).

### `ReconnectOverlay.tsx` — Reconnection UI

Full-screen overlay shown when the WebSocket connection is lost. Uses `wsConnected` signal. Displays a spinner and "Reconnecting..." text with backdrop blur. Auto-dismisses when connection is re-established.

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

User-agent based detection adjusts:
- Font size: 14px → 12px
- Resize debounce: 50ms → 200ms
- Disables autocomplete/autocorrect on xterm textarea

### Instance lifecycle

1. `createTerminal(sessionId, container)` — creates Terminal + FitAddon, attaches to DOM
2. ResizeObserver triggers `fitAddon.fit()` + sends `console:resize` via WS
3. `onData` handler sends keystrokes via `wsSend({type: 'console:input'})`
4. `destroyTerminal(sessionId)` — disposes terminal + observer

**ResizeObserver cleanup**: The observer is disconnected when `destroyTerminal()` is called (on explicit session close or exit). For component lifecycle cleanup, ensure terminals are destroyed when ClaudeSection unmounts.

### Mobile scroll lock mechanism

On mobile, when a user scrolls up to read terminal history, xterm.js's built-in auto-scroll would normally yank them back to the bottom on new output. The scroll lock system prevents this:

1. Viewport scroll listener detects when user is not at bottom (`scrollTop + clientHeight < scrollHeight - 10px`)
2. Sets `scrollLocked` flag for that sessionId
3. When locked, `writeToTerminal()` saves `viewport.scrollTop` before `term.write()`, then restores it in the callback
4. User scrolling to bottom clears the lock (via `scrollToBottom()`)

This defeats xterm's internal auto-scroll while preserving normal behavior when user is at bottom.

### Mobile toolbar adaptive mode

The mobile toolbar automatically adapts to terminal prompts:
- **Default mode**: Shows shortcuts (^C, ^U, ^D, ^L, ^A, ^E, ^R, ^W, ^V)
- **Y/N mode**: When terminal buffer contains patterns like `(y/n)`, `[Y/n]`, `[y/N]`, shows large Y/N buttons
- Detection is **event-driven** via `onTerminalWrite` subscription — incoming data chunks are tested directly; on newlines, the full buffer is re-checked at a 300ms throttle to avoid main-thread pressure during heavy streaming output
- Mode switches as soon as a matching chunk arrives (fast path) or within 300ms of the newline that produces the prompt (slow path)

### Mobile terminal known limitations

The mobile terminal has known limitations inherited from xterm.js:

- **Predictive text**: Android GBoard and iOS predictive keyboards surround enter/backspace with composition events, causing text duplication or unexpected behavior. Workaround: use the custom toolbar virtual keys for reliable input.
- **Copy/paste**: Touch-based text selection works but clipboard access is unreliable across browsers and devices. iPad trackpad + Cmd+C may fail silently.
- **Touch events**: xterm.js has no dedicated touch gesture support; relies on mouse event emulation, which can cause inconsistent behavior on mobile browsers.
- **Custom toolbar mitigation**: The fixed-bottom toolbar with virtual keys (ESC, Tab, Ctrl+C, arrow keys, shortcuts) provides reliable input for common operations that would otherwise be unreliable via the on-screen keyboard.
- **Safe-area insets**: The toolbar uses `env(safe-area-inset-bottom)` for iPhone notch/home indicator support.

**Fixed (2026-02-21)**: Input freeze during typing. Multiple overlapping `recalcLayout` timers (from `onFocus` and `visualViewport.resize`) were scheduling concurrent `fitAddon.fit()` calls, causing DOM reflow thrashing that stalled the main thread for 1–10s. Fixed by: (1) module-level debounced `fitTerminal` collapsing all calls into one, (2) removing redundant `onFocus` timers, (3) reducing stabilization retry delays from `[500,1500,4000,10000]` to `[500,1500]`, (4) skipping `repaintTerminal` while mobile input is focused.

For upstream tracking, see: [xterm.js #2403](https://github.com/xtermjs/xterm.js/issues/2403), [#5377](https://github.com/xtermjs/xterm.js/issues/5377), [#1101](https://github.com/xtermjs/xterm.js/issues/1101).

### Security considerations

**ANSI escape sequences**: The terminal outputs data from backend PTY without additional sanitization. While xterm.js has internal protections against known exploits (e.g., DCS vulnerability), the security model assumes trusted backend. For untrusted or multi-tenant environments, implement application-level ANSI filtering to strip dangerous sequences (OSC, DCS, PM, APC).

**Terminal output trust boundary**: All data flowing through `writeToTerminal()` originates from backend PTY processes. Compromise of backend → arbitrary terminal output → potential browser exploit via crafted ANSI sequences. Defense-in-depth: validate/sanitize at backend PTY spawn and/or frontend write layer.

---

## API Client (`api.ts`)

```typescript
apiFetch(url, options)
  → Adds 'Authorization: Bearer <token>' header
  → Adds 'Content-Type: application/json'
  → On 401: clearAuthToken(), view='auth', throw error
```

Token stored in `localStorage` key `codeck_auth_token`.

---

## WebSocket Client (`ws.ts`)

### Connection & Authentication

- Connects to `ws://host?token=<token>` (or `wss://` for HTTPS)
- **Authentication method**: Token passed as URL query parameter
  - **Security tradeoff**: URLs get logged by web servers, reverse proxies, and observability tools
  - **Mitigation**: TLS prevents MITM, browsers don't cache WebSocket URLs
  - **Best practice alternative**: First-message authentication (send token in initial WS message after handshake) or ephemeral single-use tokens
- Token retrieved from `getAuthToken()` which reads from `localStorage` key `codeck_auth_token`
- **Origin validation**: Performed server-side during WebSocket upgrade (client-side origin validation is not possible)

### Connection Management

- Auto-reconnect with exponential backoff (1s → 2s → 4s → ... → 30s cap, resets on success)
- Max 15 reconnect attempts before giving up
- Jitter applied to backoff (50-100% of delay) to spread out reconnection attempts
- Stale connection detector: checks every 10s, force-closes if no data for 45s
- Buffered resize: If disconnected, buffers the latest `console:resize` message to send after reconnect

### Message Handling

- **Message validation**: All incoming messages validated against known type set (`KNOWN_MSG_TYPES`) before processing
- On `status` message: syncs session list from server, then re-attaches to all current sessions (prevents stale session ghosts after container restart)
- Message handlers: `status`, `log`, `logs`, `ports`, `sessions:restored`, `console:error`, `console:output`, `console:exit`, `agent:update`, `agent:output`, `agent:execution:start`, `agent:execution:complete`
- `console:error` with `sessionId` removes ghost sessions from the frontend (session no longer exists on server)
- `wsSend(msg)` — JSON-serializes and sends if connected; queues resize messages if disconnected

### Terminal Handlers

- `setTerminalHandlers(onOutput, onExit)` — registers callbacks for terminal I/O
- `onOutput(sessionId, data)` — called on `console:output` messages, writes to xterm.js
- `onExit(sessionId)` — called on `console:exit`, destroys terminal and shows notification if tab hidden

---

## CSS Architecture

### Design tokens (`variables.css`)

Dark-only theme with indigo accent:
- Backgrounds: `#0a0a0b` → `#2a2a30` (6 levels: primary, secondary, tertiary, card, hover, active)
- Text: `#fafafa` → `#606068` (3 levels: primary, secondary, muted)
- Accent: `#6366f1` (indigo)
- Status: green/yellow/red with 12% alpha subtle variants
- Fonts: `--font-sans` (Inter), `--font-mono` (JetBrains Mono)
- Transitions: `--transition: 150ms ease`
- Info color: `--info: #3b82f6` with subtle variant
- Layout: `--sidebar-width: 260px`, `--sidebar-collapsed-width: 56px`

### Organization

- `global.css` — Reset, buttons (`.btn-*`), inputs, badges, modals, large spinner
- `app.css` — All component styles with section comments
- All icons are inline SVGs from `Icons.tsx` (no emoji anywhere)
- Backdrop blur on modals (`backdrop-filter: blur(4px)`)
- Modal entrance animation (scale 0.95 → 1 + fade)
- Responsive breakpoints at 1100px, 700px, and 600px (preset wizard cards)
- Mobile (below 700px): hamburger button on LEFT, logo+title on RIGHT; slide-down menu overlay

### Font loading

Fonts loaded from Google Fonts CDN:
- **Inter** (400, 500, 600, 700) — UI text via `--font-sans`
- **JetBrains Mono** (400, 500, 700) — Terminal and code via `--font-mono`
- Preconnect hints for `fonts.googleapis.com` and `fonts.gstatic.com`
- Preload hint for the Google Fonts CSS stylesheet
- `font-display: swap` — shows fallback text immediately, swaps when font loads (avoids FOIT)

### Future enhancements

- **Container queries**: For modular component responsiveness (93% browser support). Candidates: `.preset-cards`, `.agents-grid`, `.dash-grid`.
- **Critical CSS extraction**: Inline LoadingView + AuthView styles in `index.html` for faster FCP.
- **Mobile-first refactor**: Convert `max-width` media queries to `min-width` (mobile-first) for progressive enhancement.
- **Self-hosted fonts**: Eliminate third-party CDN dependency for GDPR compliance and offline support.

## Accessibility

Codeck targets WCAG 2.1 Level AA compliance for keyboard and screen reader users.

### Implemented patterns

- **ARIA dialog pattern**: All modals (`ConfirmModal`, `LoginModal`, `NewProjectModal`) use `role="dialog"`/`role="alertdialog"`, `aria-modal="true"`, `aria-labelledby`, focus trap (Tab cycling), and Escape key handler.
- **Semantic landmarks**: `<header>` for mobile header, `<main>` for content area, `<aside>` for sidebar navigation and logs drawer, `<nav>` for section navigation.
- **Focus indicators**: All interactive elements (buttons, inputs, tabs, sidebar items) have visible `:focus-visible` outlines (2px solid accent, WCAG 2.4.7).
- **ARIA labels**: Icon-only buttons use `aria-label`. Sidebar items use `aria-current="page"` for active state. Decorative icons use `aria-hidden="true"`.
- **Live regions**: Logs container uses `role="log"` with `aria-live="polite"`. Auth status messages use `role="alert"`/`role="status"`.
- **Reduced motion**: `@media (prefers-reduced-motion: reduce)` disables animations and transitions.

### Known limitations

- XTerm terminal emulator has limited screen reader support (inherent to terminal UIs).
- Full heading hierarchy (`<h1>`–`<h6>`) not yet implemented across all sections.
- Color contrast not yet validated with automated tooling — manual spot-checks done.
