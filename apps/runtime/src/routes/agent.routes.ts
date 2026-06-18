import { Router } from 'express';
import { asyncHandler } from "../utils/async-handler.js";
import { getClaudeStatus, startClaudeLogin, getLoginState, invalidateAuthCache, cancelLogin, sendLoginCode, logoutClaude, exchangeLoginCodeForAccount } from '../services/auth-anthropic.js';
import {
  listPublicAccounts,
  getDefaultAccountUuid,
  completeAccountLogin,
  renameAccount,
  setDefaultAccount,
  removeAccount,
} from '../services/accounts.js';
import { countSessionsForAccount } from '../services/console.js';
import { broadcastStatus } from '../web/websocket.js';

const router = Router();

// ── Multi-account management ──

// List connected Claude accounts (metadata only, no tokens)
router.get('/accounts', (_req, res) => {
  res.json({
    accounts: listPublicAccounts(),
    defaultAccountUuid: getDefaultAccountUuid(),
  });
});

// Complete an "add account" login: exchange the code and store it in the right
// config dir (default account re-login → ~/.claude; new account → isolated dir).
router.post('/accounts/login-code', asyncHandler(async (req, res) => {
  const { code } = req.body || {};
  if (!code || typeof code !== 'string') {
    res.status(400).json({ success: false, error: 'Code required' });
    return;
  }
  const result = await exchangeLoginCodeForAccount(code);
  if (!result.success || !result.token || !result.accountInfo) {
    res.json({ success: false, error: result.error || 'Exchange failed' });
    return;
  }
  const account = completeAccountLogin(
    result.token,
    result.refreshToken || '',
    result.accountInfo,
    result.expiresIn,
  );
  invalidateAuthCache();
  broadcastStatus();
  res.json({
    success: true,
    account: { uuid: account.uuid, email: account.email, label: account.label },
  });
}));

// Rename label / set default for an account
router.patch('/accounts/:uuid', (req, res) => {
  const { uuid } = req.params;
  const { label, isDefault } = req.body || {};
  let changed = false;
  if (typeof label === 'string' && label.trim()) {
    changed = renameAccount(uuid, label.trim()) || changed;
  }
  if (isDefault === true) {
    changed = setDefaultAccount(uuid) || changed;
  }
  if (!changed) {
    res.status(404).json({ error: 'Account not found or nothing to update' });
    return;
  }
  broadcastStatus();
  res.json({ success: true, defaultAccountUuid: getDefaultAccountUuid() });
});

// Remove an account (blocked while it has live sessions)
router.delete('/accounts/:uuid', (req, res) => {
  const { uuid } = req.params;
  const live = countSessionsForAccount(uuid);
  if (live > 0) {
    res.status(409).json({
      error: `Account has ${live} active session${live > 1 ? 's' : ''}. Close them first.`,
    });
    return;
  }
  if (!removeAccount(uuid)) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }
  invalidateAuthCache();
  broadcastStatus();
  res.json({ success: true, defaultAccountUuid: getDefaultAccountUuid() });
});

// Start Claude login
router.post('/login', asyncHandler(async (_req, res) => {
  const currentState = getLoginState();
  if (currentState.active) {
    res.json({
      started: false,
      inProgress: true,
      url: currentState.url,
      waitingForCode: currentState.waitingForCode,
      message: currentState.url ? 'Login in progress, waiting for code' : 'Login in progress, waiting for URL...',
    });
    return;
  }

  res.json({ started: true, message: 'Login started' });

  startClaudeLogin({
    onUrl: (url) => {
      console.log('[Server] Login URL received:', url);
      broadcastStatus();
    },
    onSuccess: () => {
      console.log('[Server] Login successful');
      invalidateAuthCache();
      broadcastStatus();
    },
    onError: () => {
      console.log('[Server] Login error');
      broadcastStatus();
    },
  });
}));

// Claude login status — during an active login, only report authenticated
// if the login flow itself completed (not from stale cache)
router.get('/login-status', (_req, res) => {
  const loginState = getLoginState();
  // Only check real auth if no login is in progress — prevents stale cache
  // from auto-closing the modal before user submits the code
  const authenticated = loginState.active ? false : getClaudeStatus().authenticated;
  res.json({
    inProgress: loginState.active,
    url: loginState.url,
    error: loginState.error,
    authenticated,
  });
});

// Send authentication code
router.post('/login-code', asyncHandler(async (req, res) => {
  const { code } = req.body;
  if (!code) {
    res.status(400).json({ success: false, error: 'Code required' });
    return;
  }

  const result = await sendLoginCode(code);
  if (result.success) {
    broadcastStatus();
  }
  res.json(result);
}));

// Cancel Claude login
router.post('/login-cancel', (_req, res) => {
  cancelLogin();
  broadcastStatus();
  res.json({ success: true });
});

// Disconnect Claude account — clears all OAuth state, keeps workspace data
router.post('/logout', (_req, res) => {
  logoutClaude();
  broadcastStatus();
  res.json({ success: true });
});

export default router;
