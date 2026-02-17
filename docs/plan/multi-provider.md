# Multi-Provider AI Agent Support

## Context

Codeck is currently hardcoded to Claude Code CLI. The user wants to support multiple AI agent CLIs (starting with Claude + OpenAI Codex) so that:
- Users can authenticate with multiple providers independently
- When creating a terminal or proactive agent, they choose which provider to use
- Both providers can work simultaneously in the same container

## Provider Comparison

| Feature | Claude | Codex |
|---------|--------|-------|
| Package | `@anthropic-ai/claude-code` | `@openai/codex` |
| Binary | `claude` | `codex` |
| Interactive | `claude` | `codex` |
| Headless | `claude -p "prompt" --output-format stream-json` | `codex exec "prompt" --json --full-auto` |
| Model flag | `--model opus` | `--model gpt-5-codex` |
| Resume | `--resume` / `--continue` | `codex resume` |
| Auth env | `CLAUDE_CODE_OAUTH_TOKEN` | `CODEX_API_KEY` |
| Auth type | OAuth PKCE | API key |
| Config dir | `~/.claude/` | `~/.codex/` |

## Implementation Plan

### Phase 1: Provider Types + Registry (new files, no changes to existing code)

**New files:**

1. **`src/services/providers/types.ts`** — Provider interfaces:
   - `ProviderFlags` — CLI flag mapping (prompt, model, version, resume, outputFormat, verbose)
   - `ProviderAuth` — Auth config (type: 'oauth-pkce' | 'api-key', envVar, tokenPrefix)
   - `ProviderDefinition` — Full provider config (id, name, command, npmPackage, flags, auth, configDir, models[], onboarding?(), parseStreamOutput?())
   - `ProviderStatus` — Status for API response (id, name, installed, authenticated, authType, models)

2. **`src/services/providers/registry.ts`** — Provider registry:
   - `registerProvider(def)`, `getProvider(id)`, `getDefaultProvider()`, `listProviders()`
   - `getInstalledProviders()` — filters by binary existence on system

3. **`src/services/providers/claude.ts`** — Claude provider definition (extract from current `ACTIVE_AGENT`)

4. **`src/services/providers/codex.ts`** — Codex provider definition:
   - command: `codex`, headless: `codex exec "prompt" --json --full-auto`
   - models: Default, o3, o4-mini, gpt-4.1
   - parseStreamOutput for Codex JSONL format

### Phase 2: Auth Abstraction (wrap existing auth, don't modify it)

**New files:**

5. **`src/services/providers/auth-types.ts`** — Auth handler interface:
   - `isAuthenticated()`, `getEnvVars()`, `getToken()`
   - Optional: `startLogin()`, `sendLoginCode()`, `cancelLogin()` (for OAuth)
   - Optional: `setApiKey()`, `getApiKey()` (for API key providers)
   - `getAccountInfo()`, `getStatus()`

6. **`src/services/providers/auth-claude.ts`** — Thin adapter wrapping `auth-anthropic.ts` (no changes to auth-anthropic.ts)

7. **`src/services/providers/auth-codex.ts`** — Codex API key handler:
   - Stores key encrypted in `/workspace/.codeck/providers/codex-key.enc`
   - Uses same encryption helpers as auth-anthropic (scrypt + AES)
   - `setApiKey(key)` saves, `getEnvVars()` returns `{ CODEX_API_KEY: key }`
   - Also checks `process.env.CODEX_API_KEY` as fallback

8. **`src/services/providers/auth-registry.ts`** — Auth handler registry:
   - `registerAuthHandler()`, `getAuthHandler()`, `isProviderAuthenticated()`, `getProviderEnvVars()`

### Phase 3: Wire Registry into Existing Services

**Modify `src/services/agent.ts`:**
- Import and register both providers + auth handlers on module load
- Keep `ACTIVE_AGENT` export pointing to Claude for backward compat
- Codex only registered if binary exists (try/catch `which codex`)

**Modify `src/services/claude-env.ts`:**
- Add `resolveProviderBinary(providerId)` — same logic but using provider.command
- Add `getProviderEnv(providerId)` — calls auth registry for env vars
- Keep existing `resolveAgentBinary()`, `getOAuthEnv()` as Claude-specific aliases

**Modify `src/services/console.ts`:**
- Add `provider?: string` to `CreateSessionOptions` (default: 'claude')
- Add `provider: string` to `ConsoleSession` interface
- `createConsoleSession()`: resolve binary/flags/env from registry based on provider
- `SavedSession` gains `provider` field (default 'claude' on load for old data)
- `listSessions()` return includes `provider`
- `restoreSavedSessions()` passes provider through

**Modify `src/services/proactive-agents.ts`:**
- Add `provider: string` to `AgentConfig` (default: 'claude')
- `executeAgent()`: get binary/flags/env from registry
- Build spawn args from provider.flags instead of hardcoded `--output-format stream-json`
- Use `provider.parseStreamOutput()` for stream parsing
- Only call Claude-specific functions (ensureOnboardingComplete, syncToClaudeSettings) when provider is claude

### Phase 4: API Routes

**New file: `src/routes/providers.routes.ts`:**
- `GET /api/providers` — list installed providers with auth status + models
- `POST /api/providers/:id/login` — start OAuth flow (for OAuth providers)
- `POST /api/providers/:id/login-code` — submit OAuth code
- `POST /api/providers/:id/api-key` — set API key (for API key providers)
- `DELETE /api/providers/:id/logout` — clear auth for provider

**Modify `src/routes/console.routes.ts`:**
- `POST /create` accepts optional `provider` in body (default: 'claude')
- Validates provider is installed + authenticated before creating session

**Modify `src/routes/agents.routes.ts`:**
- `POST /` (create agent) accepts `provider` field
- `GET /` returns `provider` in agent list

**Modify `src/web/server.ts`:**
- Status response includes `providers[]` array with auth status
- WS `status` message includes providers
- Register providers.routes

### Phase 5: Frontend

**Modify `src/web/src/state/store.ts`:**
- Add `ProviderInfo` type and `providers` signal
- Populate from status response

**Modify `src/web/src/components/LoginModal.tsx`:**
- Accept `providerId` prop
- Two modes: OAuth flow (Claude, current UI) vs API key input (Codex, simple text field)
- API key mode: input field + save button, calls `POST /api/providers/codex/api-key`

**Modify `src/web/src/app.tsx`:**
- Parse providers from status, populate store
- Show provider auth status in home/dashboard
- Pass provider to session creation

**Modify `src/web/src/components/NewProjectModal.tsx`:**
- Add provider selector dropdown (only shown if >1 authenticated provider)
- Pass selected provider to `POST /api/console/create`

**Modify `src/web/src/components/AgentsSection.tsx`:**
- Add provider selector to CreateAgentModal
- Dynamic MODEL_OPTIONS based on selected provider's models[]
- Agent cards show provider badge
- Pass provider to `POST /api/agents`

**Modify `src/web/src/components/HomeSection.tsx`:**
- Provider status cards: show each installed provider with auth status
- Login/Set API Key buttons per unauthenticated provider

### Phase 6: Docker

**Modify `Dockerfile.base`:**
- Add `ARG INSTALL_CODEX=true`
- Conditionally install `@openai/codex@latest` based on build arg

**Modify `Dockerfile.dev` (if exists):**
- Same conditional Codex install

### Phase 7: Docs + Usage

**Modify `src/services/agent-usage.ts`:**
- Provider dispatch: only Claude has usage API, others return `{ available: false }`

**Update docs:**
- `docs/ARCHITECTURE.md` — Multi-provider section
- `docs/API.md` — New /api/providers endpoints
- `docs/SERVICES.md` — Provider registry service
- `docs/CONFIGURATION.md` — INSTALL_CODEX build arg, API key config

## Backward Compatibility

- `ACTIVE_AGENT` export preserved, always points to Claude
- All API endpoints default to `provider: 'claude'` when omitted
- Old sessions.json without `provider` field → defaults to 'claude'
- Old agent configs without `provider` → defaults to 'claude'
- If only Claude is installed, UI looks identical to today (no provider selectors)

## Verification

1. Build: `npm run build` compiles without errors
2. Docker: `docker build --build-arg INSTALL_CODEX=true -t codeck-base -f Dockerfile.base .`
3. Claude flow: create terminal → works exactly as before (no provider selection if only Claude)
4. Codex flow: set API key via UI → create terminal with Codex → interactive PTY works
5. Proactive agents: create agent with provider=codex → executes `codex exec "objective" --json --full-auto`
6. Mixed: one Claude terminal + one Codex terminal running simultaneously
7. Session persistence: restart container → both Claude and Codex sessions restore correctly
