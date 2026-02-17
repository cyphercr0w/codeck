# Testing TODO

## Phase 0: Infrastructure Setup ✅ (COMPLETE - 5/5 tasks)
- [x] Install and configure vitest
- [x] Setup test scripts in package.json
- [x] Configure coverage reporting
- [x] Create test helpers and utilities
- [x] Verify test environment works

## Phase 1: Critical Paths (Target: 30% coverage - 22/58 tasks complete)

### Authentication & Authorization (9/9 complete ✅)
- [x] POST /api/auth/setup - password creation
- [x] POST /api/auth/login - valid credentials
- [x] POST /api/auth/login - invalid credentials
- [x] POST /api/auth/login - rate limiting
- [x] Auth middleware - valid token
- [x] Auth middleware - invalid token
- [x] Auth middleware - expired token
- [x] POST /api/auth/logout - session invalidation
- [x] POST /api/auth/change-password - password update

### OAuth Flow (4/7 complete)
- [x] POST /api/claude/login - PKCE initiation
- [x] POST /api/claude/login-status - polling
- [x] POST /api/claude/login-code - code exchange
- [x] POST /api/claude/login-cancel - flow cancellation
- [ ] Token storage encryption (AES-256-GCM)
- [ ] Token validation and caching
- [ ] Token refresh monitor (background task)

### Session Management (4/12 complete)
- [x] POST /api/console/create - create Claude session
- [x] POST /api/console/create-shell - create shell session
- [ ] POST /api/console/create - max sessions limit (5)
- [x] POST /api/console/destroy - cleanup
- [x] POST /api/console/rename - session rename
- [ ] POST /api/console/resize - PTY resize
- [ ] GET /api/console/sessions - list sessions
- [ ] GET /api/console/has-conversations - check resumable
- [ ] WebSocket console:attach
- [ ] WebSocket console:input
- [ ] WebSocket console:output handling
- [ ] Session state persistence (auto-restore)

### File Operations (0/5 complete)
- [ ] GET /api/files - list directory
- [ ] GET /api/files/read - read file (max 100KB)
- [ ] PUT /api/files/write - create/update file (max 500KB)
- [ ] POST /api/files/mkdir - create directory
- [ ] Path traversal protection (all file endpoints)

### WebSocket Protocol (0/7 complete)
- [ ] Connection with valid token (query param)
- [ ] Connection with invalid token
- [ ] Status message broadcast
- [ ] Heartbeat mechanism (25s interval)
- [ ] Client stale connection detection (45s)
- [ ] Reconnection logic
- [ ] Log streaming (console.log interception)

### Git & GitHub (0/9 complete)
- [ ] POST /api/git/clone - HTTPS clone
- [ ] POST /api/git/clone - SSH clone
- [ ] POST /api/git/clone - invalid URL protection
- [ ] POST /api/github/login - device code flow start
- [ ] GET /api/github/login-status - polling
- [ ] POST /api/ssh/generate - SSH key creation
- [ ] GET /api/ssh/public-key - retrieve public key
- [ ] GET /api/ssh/test - test GitHub connection
- [ ] DELETE /api/ssh/key - delete key pair

### Dashboard & System (0/9 complete)
- [ ] GET /api/dashboard - resources + Claude usage
- [ ] GET /api/system/network-info - network mode detection
- [ ] POST /api/system/add-port - port exposure (bridge mode)
- [ ] POST /api/system/add-port - already mapped
- [ ] POST /api/system/remove-port - port removal
- [ ] GET /api/ports - list active ports
- [ ] POST /api/system/update-agent - CLI update
- [ ] GET /api/workspace/export - tar.gz export
- [ ] Workspace export symlink protection

## Phase 2: Service Layer (Target: 70% coverage - 0/150+ tasks)

### services/auth.ts ✅ (Complete - 81% coverage)
- [x] setupPassword - scrypt hashing
- [x] setupPassword - salt generation
- [x] validatePassword - correct password
- [x] validatePassword - incorrect password
- [x] validatePassword - timing attack resistance
- [x] generateSessionToken - randomness
- [x] validateSession - valid session
- [x] validateSession - expired session
- [x] Session persistence
- [x] Session cleanup
- [x] Legacy SHA-256 migration
- [x] Scrypt cost upgrade
- [x] changePassword - verification
- [x] changePassword - invalidate all sessions

### services/auth-anthropic.ts (Partial - 58% coverage)
- [ ] startOAuthLogin - PKCE generation (code_verifier, code_challenge)
- [ ] startOAuthLogin - state management
- [ ] startOAuthLogin - concurrent request handling
- [ ] completeOAuthLogin - code exchange
- [ ] completeOAuthLogin - token encryption (AES-256-GCM)
- [ ] completeOAuthLogin - invalid code handling
- [ ] isAuthenticated - cache hit
- [ ] isAuthenticated - cache miss
- [ ] isAuthenticated - token validation
- [ ] Token refresh monitor - 5min interval check
- [ ] Token refresh monitor - 30min expiration margin
- [ ] Token expiration detection
- [ ] Credential file encryption/decryption
- [ ] cancelOAuthLogin - state cleanup

### services/console.ts (Partial - 22% coverage)
- [ ] createSession - PTY spawn with Claude CLI
- [ ] createSession - environment setup (TERM, PATH)
- [ ] createSession - max sessions limit (5)
- [ ] createSession - invalid cwd handling
- [ ] createShellSession - bash spawn
- [ ] destroySession - cleanup (kill PTY, remove from map)
- [ ] getSessionCount - accurate count
- [ ] renameSession - validation
- [ ] resizeSession - PTY resize
- [ ] hasConversations - .claude directory check
- [ ] Session output buffering
- [ ] Session attach logic
- [ ] PTY exit handling
- [ ] Session state save/restore

### services/git.ts (0% coverage)
- [ ] cloneRepository - HTTPS clone
- [ ] cloneRepository - SSH clone
- [ ] cloneRepository - credentials handling
- [ ] cloneRepository - branch checkout
- [ ] cloneRepository - invalid URL rejection (SSRF protection)
- [ ] isGitInstalled - detection
- [ ] GitHub device flow - initiation
- [ ] GitHub device flow - polling
- [ ] GitHub device flow - completion
- [ ] SSH key generation - ed25519
- [ ] SSH key public key retrieval
- [ ] SSH test connection
- [ ] SSH key deletion
- [ ] isValidGitUrl - SSRF/Clone2Leak protection
- [ ] Branch name validation (flag injection protection)

### services/memory.ts (5% coverage)
- [ ] Flush operations - rate limiting (1 req/30s)
- [ ] Flush - global scope
- [ ] Flush - path scope
- [ ] Path-scoped memory - create
- [ ] Path-scoped memory - resolve
- [ ] Path-scoped memory - read/write
- [ ] Daily logs - append
- [ ] Daily logs - list
- [ ] Daily logs - read specific date
- [ ] Durable memory - read
- [ ] Durable memory - write
- [ ] Durable memory - append to section
- [ ] Decisions (ADRs) - create
- [ ] Decisions - list
- [ ] Decisions - read
- [ ] Promote - daily to durable
- [ ] Promote - session to durable
- [ ] Promote - content to ADR
- [ ] Context assembly - global + today's daily
- [ ] Context assembly - path-scoped
- [ ] Session transcript - write
- [ ] Session transcript - read
- [ ] Session transcript - list
- [ ] Search - query parsing
- [ ] Search - scope filtering

### services/memory-indexer.ts (0% coverage)
- [ ] Initialize - SQLite database creation
- [ ] Initialize - FTS5 table setup
- [ ] File watcher - detect changes
- [ ] Index file - chunk creation
- [ ] Index file - metadata extraction
- [ ] Reindex - full rebuild
- [ ] Reindex - optimize (FTS5)
- [ ] Shutdown - close connections

### services/memory-search.ts (0% coverage)
- [ ] Search - BM25 full-text search
- [ ] Search - hybrid search (BM25 + vector)
- [ ] Search - scope filtering (durable/daily/decision/path/session)
- [ ] Search - date range filtering
- [ ] Search - project filtering
- [ ] Search stats - file count, chunk count
- [ ] Vector availability detection
- [ ] Shutdown - close read connection

### services/preset.ts (0% coverage)
- [ ] List presets - manifest parsing
- [ ] Get preset status - current preset detection
- [ ] Apply preset - file writes (absolute paths)
- [ ] Apply preset - directory creation
- [ ] Reset preset - force re-apply
- [ ] Preset validation - manifest schema
- [ ] File conflict handling

### services/proactive-agents.ts (0% coverage)
- [ ] Create agent - config validation
- [ ] Create agent - cron schedule parsing
- [ ] Create agent - directory creation
- [ ] Update agent - config update
- [ ] Pause agent - stop cron
- [ ] Resume agent - reset failures
- [ ] Execute agent - manual trigger
- [ ] Execute agent - auto execution (cron)
- [ ] Delete agent - cleanup files
- [ ] List agents - summary
- [ ] Get agent detail - full config
- [ ] Get execution logs - read latest
- [ ] Get execution history - list 100 recent
- [ ] Get live output - streaming
- [ ] Concurrent execution lock
- [ ] Agent failure tracking
- [ ] Execution pruning - keep last 100
- [ ] Objective linting - suspicious patterns
- [ ] Secret sanitization in output

### services/port-manager.ts (0% coverage)
- [ ] initPortManager - network mode detection
- [ ] initPortManager - read env vars
- [ ] getNetworkInfo - mode + mapped ports
- [ ] addPort - bridge mode auto-restart
- [ ] addPort - host mode (no-op)
- [ ] addPort - already mapped detection
- [ ] removePort - override rewrite
- [ ] removePort - container restart
- [ ] Docker helper - inspect container
- [ ] Docker helper - write override file

### services/ports.ts (0% coverage)
- [ ] startPortScanner - 5s interval
- [ ] detectListeningPorts - netstat parsing
- [ ] Port state tracking
- [ ] stopPortScanner - cleanup

### services/session-writer.ts (3% coverage)
- [ ] Write session input - JSONL format
- [ ] Write session output - JSONL format
- [ ] Secret sanitization - Bearer tokens
- [ ] Secret sanitization - API keys
- [ ] Secret sanitization - JWTs
- [ ] Secret sanitization - AWS tokens
- [ ] Secret sanitization - Database URLs
- [ ] Secret sanitization - PEM keys
- [ ] Truncate output - 10KB max
- [ ] JSONL formatting - proper newlines

### services/resources.ts (0% coverage)
- [ ] getResources - CPU usage (cgroups v2)
- [ ] getResources - memory usage
- [ ] getResources - disk usage
- [ ] getResources - uptime
- [ ] CPU delta calculation

### services/permissions.ts (0% coverage)
- [ ] getPermissions - read from config
- [ ] setPermissions - update config
- [ ] syncToClaudeSettings - write ~/.claude/settings.json
- [ ] Default permissions - all true

### services/mdns.ts (0% coverage)
- [ ] startMdns - responder creation
- [ ] startMdns - codeck.local
- [ ] startMdns - {port}.codeck.local
- [ ] stopMdns - cleanup

### services/claude-env.ts (0% coverage)
- [ ] buildCleanEnv - strip sensitive env vars
- [ ] buildCleanEnv - preserve PATH/HOME/TERM
- [ ] syncClaudeSettings - read permissions
- [ ] syncClaudeSettings - write settings.json

### services/agent-usage.ts (0% coverage)
- [ ] fetchUsage - API call to Anthropic
- [ ] fetchUsage - 60s TTL cache
- [ ] Parse usage response - 5h window
- [ ] Parse usage response - 7d window

### services/session-summarizer.ts (0% coverage)
- [ ] Summarize session - parse JSONL
- [ ] Extract metadata - cwd, timestamps
- [ ] Count lines
- [ ] Calculate duration

### services/embeddings.ts (0% coverage)
- [ ] Generate embeddings - @xenova/transformers
- [ ] Chunk text - sentence splitting
- [ ] Availability detection

### services/environment.ts (0% coverage)
- [ ] Detect Docker - .dockerenv check
- [ ] Detect Docker - cgroup check

## Phase 3: Edge Cases & Integration (Target: 100% coverage)

### Error Handling (0/20 complete)
- [ ] Network failures during OAuth
- [ ] Disk full during file write
- [ ] PTY spawn failures - invalid cwd
- [ ] PTY spawn failures - permission denied
- [ ] WebSocket disconnections - client drop
- [ ] WebSocket disconnections - server restart
- [ ] Concurrent session operations - race conditions
- [ ] Invalid JSON payloads
- [ ] Large file uploads - exceeding 500KB limit
- [ ] Memory indexer failures - SQLite errors
- [ ] Docker API failures - container not found
- [ ] Docker API failures - permission denied
- [ ] Git clone failures - auth required
- [ ] Git clone failures - invalid branch
- [ ] Preset apply failures - file conflicts
- [ ] Agent execution failures - timeout
- [ ] Agent execution failures - max retries
- [ ] Session restore failures - stale PIDs
- [ ] Token refresh failures - expired refresh token
- [ ] Search failures - malformed queries

### Security (0/15 complete)
- [ ] SQL injection attempts - FTS5 queries
- [ ] XSS in file contents - sanitization
- [ ] Path traversal - ../ sequences
- [ ] Path traversal - symlinks
- [ ] Path traversal - absolute paths
- [ ] Rate limit bypass attempts - IP spoofing
- [ ] Secret leakage - log sanitization all patterns
- [ ] Session fixation - token rotation
- [ ] Timing attacks - constant-time comparison (auth.ts)
- [ ] SSRF - git clone URL validation
- [ ] Command injection - git branch names
- [ ] File inclusion - preset file paths
- [ ] Workspace export - symlink leakage
- [ ] Agent objective - Docker escape attempts
- [ ] OAuth state CSRF protection

### Integration Tests (0/12 complete)
- [ ] Full auth flow - setup → login → create session → run command
- [ ] Full OAuth flow - initiate → code → token → API call → usage check
- [ ] Multi-session concurrent operations - 5 sessions
- [ ] Port exposure workflow - detect → add → restart → verify
- [ ] Workspace export - create files → export → verify tar.gz
- [ ] Preset application - apply → verify files → reset
- [ ] Memory promotion - daily entry → promote to durable → verify
- [ ] Proactive agent lifecycle - create → schedule → execute → logs → delete
- [ ] Session restore - create → save state → simulate restart → restore
- [ ] WebSocket full flow - connect → attach → input → output → disconnect
- [ ] Git integration - clone → SSH setup → commit (via Claude)
- [ ] File browser - list → read → write → delete → verify

### Frontend Components (0/10 complete - Lower Priority)
- [ ] Login form - password validation
- [ ] Login form - submission
- [ ] Session list - rendering
- [ ] Session tabs - switching
- [ ] Terminal - xterm.js rendering
- [ ] Terminal - input handling
- [ ] File browser - navigation
- [ ] File browser - file operations
- [ ] Log drawer - toggle
- [ ] WebSocket reconnection UI

---

**Total Progress:** 22/250+ tasks complete (~8.8%)
**Current Phase:** Phase 1 (Critical Paths)
**Current Session:** Session 1 - Master Planning (Complete ✅)
**Next Session:** Session 2 - Complete auth.ts coverage
**Next Task:** Implement missing edge cases in auth.test.ts to reach 100% coverage
