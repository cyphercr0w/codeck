import { Router } from 'express';
import { getClaudeStatus, startClaudeLogin, getLoginState, invalidateAuthCache, cancelLogin, sendLoginCode } from '../services/auth-anthropic.js';
import { broadcastStatus } from '../web/websocket.js';

const router = Router();

// Start Claude login
router.post('/login', async (_req, res) => {
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
});

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
router.post('/login-code', async (req, res) => {
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
});

// Cancel Claude login
router.post('/login-cancel', (_req, res) => {
  cancelLogin();
  broadcastStatus();
  res.json({ success: true });
});

export default router;
