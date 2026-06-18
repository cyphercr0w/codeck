# Multi-Account Claude Support — Design

**Date:** 2026-06-18
**Status:** Approved → implementing

## Goal

Let Codeck connect **more than one Claude account** and run workspaces with
different accounts **concurrently** (workspace A on account 1, workspace B on
account 2 at the same time). The account is chosen per session in the launch
popup (`NewProjectModal`, step 2), and accounts are managed in a new
**Settings → Accounts** card.

## Chosen approach (Option A): per-account `CLAUDE_CONFIG_DIR`

Claude Code CLI keeps credentials, `projects/` history, `settings.json` and
performs token refresh inside a config directory. Two accounts sharing
`~/.claude` would collide (refresh rewrites the shared `.credentials.json`,
history mixes). The CLI honours `CLAUDE_CONFIG_DIR`, so each account gets its
own directory.

- **Existing / default account:** stays at `~/.claude` (legacy layout, where
  `.claude.json` lives at `~/.claude.json`). We do **not** set
  `CLAUDE_CONFIG_DIR` for it — zero risk to the working flow.
- **Additional accounts:** live at `/workspace/.codeck/accounts/<uuid>/`. For
  these sessions we set `CLAUDE_CONFIG_DIR=<that dir>`; the CLI puts
  `.credentials.json`, `projects/`, `settings.json` and `.claude.json` there.

The asymmetry (default = legacy, extras = isolated dir) is intentional and
keeps the migration risk-free.

## Data model

### Registry — `/workspace/.codeck/accounts.json` (mode 0600)

```jsonc
{
  "version": 1,
  "accounts": [
    {
      "uuid": "<accountUuid or synthetic>",
      "email": "user@example.com",
      "organizationName": "Org",
      "organizationUuid": "...",
      "label": "Work",          // user-editable; defaults to email/org
      "configDir": "/root/.claude" | "/workspace/.codeck/accounts/<uuid>",
      "isDefault": true,
      "addedAt": 1718...
    }
  ]
}
```

Credentials themselves are **not** in the registry — they stay in each
account's `configDir` (plaintext `.credentials.json` CLI-compatible + encrypted
backup), reusing the existing AES-256-GCM helpers.

### Derived paths per account (`getAccountPaths`)

| Field | Default account | Additional account |
|-------|-----------------|--------------------|
| `configDir` | `~/.claude` | `/workspace/.codeck/accounts/<uuid>` |
| `credentialsFile` | `~/.claude/.credentials.json` | `<configDir>/.credentials.json` |
| `configFile` (.claude.json) | `~/.claude.json` | `<configDir>/.claude.json` |
| `settingsFile` | `~/.claude/settings.json` | `<configDir>/settings.json` |
| `projectsDir` | `~/.claude/projects` | `<configDir>/projects` |
| `setConfigDirEnv` | `false` | `true` |

## Backend changes

- **`services/accounts.ts`** (new): registry load/save, `listAccounts`,
  `getAccount`, `getDefaultAccount`, `setDefaultAccount`, `renameAccount`,
  `removeAccount`, `resolveAccountForSession(uuid?)`, `getAccountPaths`,
  `getAccountSessionEnv(account)` → `{ CLAUDE_CODE_OAUTH_TOKEN, [CLAUDE_CONFIG_DIR] }`,
  `prepareAccountConfigDir(account)`, `migrateExistingAccountIfNeeded()`,
  `addOrUpdateAccountFromExchange(...)`, `startAccountsRefreshMonitor()`,
  `hasValidToken(account)`.
- **`services/auth-anthropic/account-store.ts`** (new): per-`configDir`
  credential read/write/refresh (reuses `encryption.ts`).
- **`services/auth-anthropic.ts`**: extract token exchange into a helper and add
  `exchangeLoginCodeForAccount(code)` that returns `{ tokenData, accountInfo }`
  without saving to the default paths. Default `sendLoginCode` unchanged in
  behaviour.
- **`services/claude-env.ts`**: `ensureOnboardingComplete(configFile?)` gains an
  optional target.
- **`services/permissions.ts`**: `syncToClaudeSettings(settingsFile?)` gains an
  optional write target (MCP list still read from the global mcp.json).
- **`services/console.ts`**: `CreateSessionOptions.accountUuid`. Resolve account,
  `prepareAccountConfigDir`, use `getAccountSessionEnv`, and use the account's
  `projectsDir` for conversation detection / resume helpers. Track
  `accountUuid`/`accountEmail` on the session; expose in `listSessions`.
- **Routes:**
  - `agent.routes.ts` (`/api/claude`): `GET /accounts`, `POST /accounts/login-code`,
    `PATCH /accounts/:uuid`, `DELETE /accounts/:uuid`. (Add-account reuses the
    existing `POST /login` to start PKCE.)
  - `console.routes.ts`: `/create` accepts `accountUuid`;
    `has-conversations` & `recent-conversations` accept an `accountUuid` query.
- **Status payload** (`websocket.ts` + `/api/status`): add `accounts` (public
  metadata + `hasToken`) and `defaultAccountUuid`.
- **Startup** (`server.ts`): `migrateExistingAccountIfNeeded()` +
  `startAccountsRefreshMonitor()`.

## Frontend changes

- **`state/store.ts`**: `Account` type, `accounts` + `defaultAccountUuid`
  signals, handle them in `updateStateFromServer`; add `accountUuid`/
  `accountEmail` to `TerminalSession`.
- **`SettingsSection.tsx`**: new **Accounts** card — list (email, org, default
  badge, "needs re-login" state), Add account, rename label, set default,
  remove.
- **`LoginModal.tsx`**: optional `addAccount` mode → submits to
  `/api/claude/accounts/login-code` and refreshes the account list instead of
  flipping global auth.
- **`NewProjectModal.tsx`**: account selector in step 2 (default = last used for
  that folder via localStorage, else global default); changing it re-runs the
  resume check against that account; pass `accountUuid` in `onConfirm`.
- **`app.tsx`**: include `accountUuid` in the `/api/console/create` body; fetch
  accounts on load/after login.
- **`ClaudeSection.tsx`**: small account badge on a session tab when the session
  uses a non-default account.

## Error handling & edge cases

- Removing an account with live sessions → blocked with a message (sessions
  track their `accountUuid`). The default account cannot be removed while it is
  the only account.
- Account whose token is dead / refresh failed → shown as "needs re-login";
  cannot launch a session until re-authenticated.
- Resume detection is always tied to the selected `accountUuid`, so it reads the
  right `projects/` dir.
- Onboarding flags + permission settings are synced into each account's config
  dir on first use; MCP server list is read from the shared global config.

## Testing

- Registry: add / migrate / dedupe-by-uuid / rename / set-default / remove.
- Path + token resolution per account; multi-account refresh.
- Two concurrent sessions on different accounts → each PTY gets the right
  `CLAUDE_CONFIG_DIR` + token; `projects/` stays separate.
