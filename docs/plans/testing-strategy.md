# Testing Strategy — Codeck

## Executive Summary

**Current State:** 11.7% test coverage (16 test files implemented)
**Target:** 100% test coverage
**Approach:** Iterative, phase-based implementation over multiple weeks
**Testing Framework:** Vitest + @testing-library/preact + Supertest
**Branch:** feature/testing-suite

---

## Inventory: What Needs Testing

### Backend Services (20 files in src/services/)

| Service | Priority | Current Coverage | Complexity |
|---------|----------|------------------|------------|
| `auth.ts` | P0 | 83.47% | Medium |
| `auth-anthropic.ts` | P0 | 59.18% | High |
| `console.ts` | P0 | 23.45% | High |
| `memory.ts` | P1 | 6.53% | High |
| `session-writer.ts` | P1 | 3.57% | Medium |
| `git.ts` | P1 | 0% | High |
| `port-manager.ts` | P1 | 0% | Medium |
| `preset.ts` | P1 | 0% | Medium |
| `memory-indexer.ts` | P2 | 0% | Medium |
| `memory-search.ts` | P2 | 0% | Medium |
| `memory-context.ts` | P2 | 0% | Low |
| `proactive-agents.ts` | P2 | 0% | High |
| `permissions.ts` | P2 | 0% | Low |
| `resources.ts` | P2 | 0% | Low |
| `claude-env.ts` | P2 | 0% | Medium |
| `environment.ts` | P2 | 0% | Low |
| `agent-usage.ts` | P2 | 0% | Low |
| `mdns.ts` | P3 | 0% | Low |
| `embeddings.ts` | P3 | 0% | Medium |
| `session-summarizer.ts` | P3 | 0% | Medium |

### API Routes (15 files in src/routes/)

| Router | Priority | Current Coverage | Endpoints |
|--------|----------|------------------|-----------|
| `agent.routes.ts` | P0 | 100% | 4 |
| `console.routes.ts` | P0 | 78.87% | 5 |
| `files.routes.ts` | P1 | 0% | 6 |
| `memory.routes.ts` | P1 | 0% | 10 |
| `git.routes.ts` | P1 | 0% | 2 |
| `github.routes.ts` | P1 | 0% | 3 |
| `ssh.routes.ts` | P1 | 0% | 3 |
| `preset.routes.ts` | P1 | 0% | 4 |
| `system.routes.ts` | P1 | 0% | 6 |
| `codeck.routes.ts` | P1 | 0% | 8 |
| `project.routes.ts` | P2 | 0% | 4 |
| `workspace.routes.ts` | P2 | 0% | 2 |
| `agents.routes.ts` | P2 | 0% | 7 |
| `dashboard.routes.ts` | P2 | 0% | 1 |
| `permissions.routes.ts` | P2 | 0% | 2 |

### Web Server (3 files in src/web/)

| File | Priority | Current Coverage |
|------|----------|------------------|
| `server.ts` | P0 | 0% |
| `websocket.ts` | P0 | 0% |
| `logger.ts` | P1 | 0% |

---

## Technology Stack

### Testing Frameworks
- **Vitest 4.0.18** ✅ Installed
- **@testing-library/preact 3.2.4** ✅ Installed
- **Supertest 7.2.2** ✅ Installed
- **@vitest/coverage-v8** ✅ Installed

### Mocking Strategy
- **File system:** Temp directories (`/tmp/codeck-test-*`) via setup.ts
- **Network calls:** `vi.mock()` for Anthropic/GitHub APIs
- **Child processes:** Mock `spawn`/`exec` for git/gh/claude CLI
- **Node-pty:** Mock PTY sessions with fake streams
- **WebSocket:** Mock `ws` library with event emitters

---

## Phase Breakdown

### Phase 0: Infrastructure Setup ✅ COMPLETED
- [x] Vitest configuration
- [x] Test scripts in package.json
- [x] Coverage reporting
- [x] Test helpers created
- [x] Smoke test passing

**Current State:** 11.7% baseline coverage

### Phase 1: Critical Paths (Target: 30% coverage)
**Duration:** 5-7 sessions (Week 1-2)

**Focus:** Auth, sessions, OAuth, WebSocket

**Tasks:**
1. Complete `auth.ts` (83% → 100%)
2. Complete `auth-anthropic.ts` (59% → 100%)
3. Complete `console.ts` (23% → 100%)
4. Add `websocket.ts` tests (0% → 100%)
5. Add `server.ts` tests (0% → 100%)
6. Add `files.routes.ts` tests (0% → 100%)
7. Improve `console.routes.ts` (79% → 100%)

**Success Criteria:**
- All P0 services at 100%
- All P0 routes at 100%
- WebSocket protocol fully tested
- ~30% total coverage

### Phase 2: Service Layer (Target: 70% coverage)
**Duration:** 10-15 sessions (Week 3-5)

**Focus:** Complete all P1 services and routes

**Tasks:**
1. `git.ts` — Clone, credentials, SSH, device flow
2. `memory.ts`, `memory-indexer.ts`, `memory-search.ts`, `memory-context.ts`
3. `port-manager.ts` — Network detection, Docker integration
4. `preset.ts` — Apply/reset presets
5. `session-writer.ts` — Complete to 100%
6. All P1 routes: memory, git, github, ssh, system, codeck

**Success Criteria:**
- All P1 services at 90%+
- All P1 routes at 90%+
- ~70% total coverage

### Phase 3: Edge Cases & Integration (Target: 100% coverage)
**Duration:** 10-15 sessions (Week 6-8)

**Focus:** Error handling, security, integration tests

**Tasks:**
1. **Error Scenarios:** Network failures, disk full, PTY spawn failures, invalid JSON
2. **Security Tests:** Path traversal, XSS, rate limit bypass, token tampering
3. **Integration Tests:** Full auth flow, OAuth flow, multi-session, port exposure, workspace export
4. **Remaining Services:** P2/P3 services (proactive-agents, resources, permissions, mdns, etc.)
5. **Remaining Routes:** P2 routes (project, workspace, agents, dashboard, permissions)

**Success Criteria:**
- 100% backend coverage
- All error paths tested
- Security vulnerabilities prevented

### Phase 4: Frontend & E2E (Optional)
**Duration:** 5-10 sessions (Week 9-10)

**Focus:** Component tests, E2E flows

**Tasks:**
1. Component tests with @testing-library/preact
2. E2E tests with Playwright (to be installed)

---

## Test Organization

### Directory Structure
```
tests/
├── setup.ts                    # Global setup (redirects to /tmp)
├── smoke.test.ts               # Smoke test
├── helpers/                    # Utilities
│   ├── auth-helpers.ts
│   ├── server-helpers.ts
│   ├── websocket-helpers.ts
│   └── fs-helpers.ts
├── fixtures/                   # Sample data
├── services/                   # Service unit tests
├── routes/                     # Route integration tests
├── web/                        # Web server tests
├── integration/                # Integration tests
└── frontend/                   # Component tests (Phase 4)
```

### Best Practices
1. **AAA Pattern:** Arrange → Act → Assert
2. **Isolation:** Independent tests, no shared state
3. **Descriptive names:** `should [expected behavior]`
4. **Mock externals:** No real API calls
5. **Fast tests:** < 5ms unit, < 100ms integration

---

## Timeline

**Estimated Duration:** 6-8 weeks
- **Week 1-2:** Phase 1 → 30% coverage
- **Week 3-5:** Phase 2 → 70% coverage
- **Week 6-8:** Phase 3 → 100% coverage
- **Week 9-10:** Phase 4 → Frontend coverage

**Last Updated:** 2026-02-17
**Status:** Active Development — Phase 1 Planning Complete
