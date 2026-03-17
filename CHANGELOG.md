# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Welcome card for first-time users on the Home dashboard
- Tab title flash notification when the agent needs attention
- Context loaded banner showing memory injection on session start
- Session status indicators in terminal tabs (running, idle, etc.)
- Memory stats card in Home dashboard — surfaces memory usage at a glance
- Complete preset manifest with hooks, scripts, and settings
- P0 brain improvements: PostCompact hook for memory preservation, command guard, Context7 MCP integration
- PreToolUse hook that reminds the agent of available skills before tool calls
- Enforce proactive use of skills, agents, and parallelization via agent rules

### Changed

- UI redesign: IBM Plex Sans font, refined dark theme across all views
- Increased memory context injection limit to 30K characters for richer agent context
- Renamed "Auto Agents" to "Scheduled Agents" throughout the UI
- Translated SettingsSection to English and improved coding rules

### Fixed

- Eliminated event loop blocking from synchronous SSH/GitHub checks at startup
- Per-client PTY dimensions now tracked correctly with focus-based activation
- Stale terminals cleaned up properly on session restore after container restart
- Skip unnecessary `fitAddon.fit()` calls when terminal dimensions haven't changed
- Audit fixes: async route handlers, Docker CI workflow, manifest completeness

### Security

- Audit fixes across auth, routes, and container configuration

## [0.1.0] - 2025-01-01

### Added

- Initial release of Codeck — persistent Docker sandbox for Claude Code
- OAuth PKCE authentication with Anthropic (bring your own account)
- Web-based terminal with xterm.js and full PTY support
- Persistent memory system: daily logs, durable memory, path-scoped memory, search (SQLite FTS5)
- Memory context injection into CLAUDE.md at session start
- Session persistence and auto-resume after container restart
- OAuth token auto-refresh monitor for 24/7 unattended sessions
- PWA support with offline shell and infinite WebSocket reconnect
- Mobile terminal UX: responsive layout, on-screen keyboard handling, touch-friendly toolbar
- Image upload via paste and drag-drop into terminal sessions
- Preset system with configurable hooks, scripts, and agent rules
- Scheduled agents (cron-like background tasks)
- File browser with symlink support, delete, and rename
- Settings section: password change, session log, auth log
- GitHub auth persistence across restarts with account info display
- Docker experimental mode with opt-in Docker socket access
- CLI (`@codeck/cli`): `init`, `start`, `stop`, `status`, `logs`, `open`, `restart`, `doctor`
- CLI workspace bind mount support (`--workspace`)
- LAN access via mDNS advertiser (`codeck.local`) with platform-specific hosts file management
- Deployment mode detection (systemd, Docker, CLI)
- Install script for VPS deployment with systemd service
- Configurable container resource limits via `.env`
- Daemon restart endpoint for runtime self-deploy

### Changed

- Monorepo structure: `apps/runtime`, `apps/web`, `apps/cli`
- Replaced local/gateway modes with isolated/managed architecture
- Daemon handles auth, webapp, and port exposure; runtime runs in isolated container
- Removed host network mode — all networking uses standard port mapping
- Removed Docker socket from default compose files (opt-in only)

### Fixed

- Terminal input freeze from multiple causes: event loop blocking, scroll lock races, mobile keyboard timer cascade, WS status reattach, buffer replay during `display:none`
- Black terminal after session restore, reconnect, and container visibility transitions
- Mobile terminal sizing and resize when virtual keyboard opens/closes
- OAuth token decryption (`[object Object]` instead of actual token)
- `scrypt` maxmem crash on Node.js 22 during password setup
- PTY echo probe that leaked visible text to terminal output
- Shell session 30-second hang caused by `--login` flag
- Infinite login loop on PTY auth error after re-authentication
- Session restore overlay getting stuck when sessions are already running
- Credentials backup EPERM on container filesystem
- Host workspace path remapping for agent spawning in managed mode

### Security

- 9-point security hardening across auth, WebSocket, agents, and containers
- Read-only `.ssh` mount in managed mode
- SSH known_hosts redirected to writable location
- Internal shared secret for daemon-runtime auth proxy
- Disabled session persistence for proactive agent executions (prevents data leaks)
