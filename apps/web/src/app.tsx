import { Component } from 'preact';
import { useEffect, useState, useRef } from 'preact/hooks';
import {
  view, activeSection, claudeAuthenticated, presetConfigured, isMobile, mobileKeyboardOpen,
  accountEmail, accountOrg, wsConnected,
  updateStateFromServer, setView, setActiveSection, setAuthMode, setActiveSessionId,
  setPresetConfigured, setAccountInfo, startUsagePolling,
  sessions, activeSessionId, addSession, removeSession, replaceSession,
  addLocalLog,
  sessionStatus,
  type View, type Section,
} from './state/store';
import { apiFetch, getAuthToken, clearAuthToken } from './api';
import { connectWebSocket } from './ws';
import { fitTerminal, scrollToBottom, repaintTerminal, ensureTerminalVisible } from './terminal';
import { LoadingView } from './components/LoadingView';
import { AuthView } from './components/AuthView';
import { SetupView } from './components/SetupView';
import { Sidebar } from './components/Sidebar';
import { HomeSection } from './components/HomeSection';
import { FilesSection } from './components/FilesSection';
import { ClaudeSection, mountTerminalForSession, restoreSessions } from './components/ClaudeSection';
import { LoginModal } from './components/LoginModal';
import { NewProjectModal } from './components/NewProjectModal';
import { LogsDrawer } from './components/LogsDrawer';
import { PresetWizard } from './components/PresetWizard';
import { IntegrationsSection } from './components/IntegrationsSection';
import { AgentConfigSection } from './components/AgentConfigSection';

import { AgentsSection } from './components/AgentsSection';
import { SettingsSection } from './components/SettingsSection';
import { MobileMenu } from './components/MobileMenu';
import { IconBridge } from './components/Icons';
import { PullToRefresh } from './components/PullToRefresh';
import { ReconnectOverlay } from './components/ReconnectOverlay';
import { initRouter, sectionFromUrl, pushSection } from './router';

// ========== Error Boundary ==========
class ErrorBoundary extends Component<{ children: any }, { hasError: boolean }> {
  state = { hasError: false };

  componentDidCatch(error: any) {
    console.error('[ErrorBoundary]', error);
    this.setState({ hasError: true });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-primary)' }}>
          <h2>Something went wrong</h2>
          <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>An unexpected error occurred in this section.</p>
          <button class="btn-primary" style={{ marginTop: '1rem' }} onClick={() => this.setState({ hasError: false })}>
            Try Again
          </button>
          <button class="btn-secondary" style={{ marginTop: '1rem', marginLeft: '0.5rem' }} onClick={() => location.reload()}>
            Reload Page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const MAX_INIT_RETRIES = 15;
const SESSION_LIMIT = 5;

export function App() {
  // Use local state for view to guarantee re-renders
  const [currentView, setCurrentView] = useState<View>('loading');
  const [section, setSection] = useState<Section>('home');
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Sync signals → local state for reliable re-renders
  useEffect(() => {
    const unsubView = view.subscribe(v => setCurrentView(v));
    const unsubSection = activeSection.subscribe(v => setSection(v));
    return () => { unsubView(); unsubSection(); };
  }, []);

  // Pull-to-refresh is handled by the PullToRefresh component.
  // It replaces the old preventPullToRefresh handler that blocked all pull gestures.

  // Start usage polling when entering main view
  useEffect(() => {
    if (currentView === 'main') {
      startUsagePolling(apiFetch);
    }
  }, [currentView]);

  // Router: init popstate listener
  useEffect(() => {
    initRouter();
  }, []);

  // Router: sync section signal → URL
  useEffect(() => {
    if (currentView === 'main') {
      pushSection(section);
    }
  }, [section, currentView]);

  // Auto-open login modal when token expires while in main view
  useEffect(() => {
    const unsub = claudeAuthenticated.subscribe(authenticated => {
      if (!authenticated && view.value === 'main' && !loginModalOpen) {
        setLoginModalOpen(true);
      }
    });
    return unsub;
  }, [loginModalOpen]);

  // ========== Tab title flash when agent needs attention ==========
  // When any session is 'waiting' or 'idle' and the user has switched tabs,
  // flash the browser tab title to attract attention. Zero-config: works for
  // all users with no permissions or setup required.
  useEffect(() => {
    const ORIGINAL_TITLE = 'Codeck';
    const FLASH_TITLES = ['\u26A1 Codeck', '\uD83D\uDCAC Input needed'];
    const FLASH_INTERVAL_MS = 1000;

    let flashTimer: ReturnType<typeof setInterval> | null = null;
    let flashIndex = 0;

    function startFlash() {
      if (flashTimer) return; // already flashing
      flashIndex = 0;
      flashTimer = setInterval(() => {
        document.title = FLASH_TITLES[flashIndex % FLASH_TITLES.length];
        flashIndex++;
      }, FLASH_INTERVAL_MS);
    }

    function stopFlash() {
      if (flashTimer) {
        clearInterval(flashTimer);
        flashTimer = null;
      }
      document.title = ORIGINAL_TITLE;
    }

    function needsAttention(): boolean {
      const statuses = sessionStatus.value;
      return Object.values(statuses).some(s => s === 'waiting');
    }

    // React to session status changes: start flash if tab is hidden + needs attention
    const unsubStatus = sessionStatus.subscribe(() => {
      if (document.hidden && needsAttention()) {
        startFlash();
      } else if (!needsAttention()) {
        stopFlash();
      }
    });

    // React to visibility changes: stop flash when user returns
    function onVisibilityChange() {
      if (!document.hidden) {
        stopFlash();
      } else if (needsAttention()) {
        startFlash();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      unsubStatus();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopFlash();
    };
  }, []);

  // ========== Initialization ==========
  const initRetryCount = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    initializeApp(controller.signal);
    return () => controller.abort();
  }, []);

  // ========== Auto-recover on WS reconnect ==========
  // If the view is stuck on 'setup' or 'loading' when WS reconnects with
  // claudeAuthenticated=true, re-run initialization to transition to 'main'.
  const initInProgress = useRef(false);
  useEffect(() => {
    let skipInitial = true; // Ignore the immediate subscribe callback
    const unsub = wsConnected.subscribe(connected => {
      if (skipInitial) { skipInitial = false; return; }
      if (connected && claudeAuthenticated.value &&
          (view.value === 'setup' || view.value === 'loading') &&
          !initInProgress.current) {
        initRetryCount.current = 0;
        initInProgress.current = true;
        initializeApp().finally(() => { initInProgress.current = false; });
      }
    });
    return unsub;
  }, []);

  async function initializeApp(signal?: AbortSignal) {
    setView('loading');

    try {
      // Fast path: if we have a token, skip /api/auth/status and go straight
      // to /api/status (saves 250ms RTT). If 401 → token is bad → show login.
      // If server isn't configured yet → /api/status returns needsAuth.
      const token = getAuthToken();

      if (!token) {
        // No token — check if password is configured
        const authRes = await fetch('/api/auth/status', { signal });
        if (!authRes.ok) throw new Error(`Auth status check failed: ${authRes.status}`);
        const authData = await authRes.json();
        if (authData.configured) {
          setView('auth');
          setAuthMode('login');
        } else {
          setView('auth');
          setAuthMode('setup');
        }
        return;
      }

      // Have token → try /api/status directly (single roundtrip)
      const testRes = await apiFetch('/api/status', { signal });
      if (testRes.status === 401) {
        // Token invalid or password not configured
        clearAuthToken();
        setView('auth');
        setAuthMode('login');
        return;
      }
      if (testRes.status >= 500) {
        throw new Error(`Server returned ${testRes.status} — runtime not ready`);
      }
      const data = await testRes.json();
      updateStateFromServer(data);

      // Claude check
      initRetryCount.current = 0;
      if (claudeAuthenticated.value) {
        if (!presetConfigured.value) {
          setView('preset');
          connectWebSocket();
          loadAccountInfo(signal); // fire and forget
        } else {
          // Show main view IMMEDIATELY — don't wait for account info or sessions.
          // Terminal appears faster, account info fills in ~250ms later.
          setActiveSection(sectionFromUrl());
          setView('main');
          connectWebSocket();
          // Fire in parallel, don't block rendering
          loadAccountInfo(signal);
          restoreSessions();
        }
      } else {
        setView('setup');
        connectWebSocket();
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      // 401 from apiFetch already set the auth view — don't retry
      if (e?.message === 'Unauthorized') return;

      // Exponential backoff with max retries — stay on loading view while retrying
      // so the user doesn't see a flash of "Connect Claude Code" during startup
      if (initRetryCount.current < MAX_INIT_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, initRetryCount.current), 30000);
        initRetryCount.current++;
        addLocalLog('warn', `Server not ready, retrying in ${Math.round(delay / 1000)}s (attempt ${initRetryCount.current}/${MAX_INIT_RETRIES})`);
        setTimeout(() => initializeApp(signal), delay);
      } else {
        // Only show setup view after all retries exhausted
        setView('setup');
        addLocalLog('error', 'Could not connect to server. Please reload the page.');
      }
    }
  }

  // ========== After auth ==========
  async function continueAfterAuth() {
    setView('loading');
    try {
      const res = await apiFetch('/api/status');
      const data = await res.json();
      updateStateFromServer(data);

      if (claudeAuthenticated.value) {
        if (!presetConfigured.value) {
          setView('preset');
          connectWebSocket();
          loadAccountInfo();
        } else {
          setActiveSection(sectionFromUrl());
          setView('main');
          connectWebSocket();
          loadAccountInfo();
          restoreSessions();
        }
      } else {
        setView('setup');
        connectWebSocket();
      }
    } catch {
      setView('setup');
      connectWebSocket();
    }
  }

  async function loadAccountInfo(signal?: AbortSignal) {
    try {
      const res = await apiFetch('/api/account', { signal });
      const data = await res.json();
      if (data.account) {
        setAccountInfo(data.account.email, data.account.organizationName, data.account.accountUuid);
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      /* ignore other errors */
    }
  }

  // ========== Login flow ==========
  function startLogin() {
    setLoginModalOpen(true);
  }

  async function handleLogout() {
    try {
      await apiFetch('/api/claude/logout', { method: 'POST' });
    } catch { /* ignore */ }
    // Reset client-side auth state and show Claude login (setup) view
    claudeAuthenticated.value = false;
    accountEmail.value = null;
    accountOrg.value = null;
    // Go to 'setup' view which shows the Claude Connect button,
    // NOT 'auth' which is the password setup/login screen
    setView('setup');
  }

  async function handleLoginSuccess() {
    setLoginModalOpen(false);
    try {
      const res = await apiFetch('/api/status');
      const data = await res.json();
      updateStateFromServer(data);
    } catch { /* ignore */ }
    if (!presetConfigured.value) {
      setView('preset');
      connectWebSocket();
      loadAccountInfo();
    } else {
      setActiveSection(sectionFromUrl());
      setView('main');
      connectWebSocket();
      loadAccountInfo();
      restoreSessions();
    }
  }

  function handleLoginClose() {
    setLoginModalOpen(false);
  }

  // ========== Preset wizard ==========
  async function handlePresetComplete() {
    setPresetConfigured(true);
    setActiveSection(sectionFromUrl());
    setView('main');
    await restoreSessions();
  }

  // ========== Section change ==========
  // When section becomes 'claude', wait for the container to have real dimensions
  // then refit + repaint. The old setTimeout(50ms) was unreliable — the container
  // transitions from display:none and may still have 0x0 dimensions at 50ms.
  // ensureTerminalVisible() polls with rAF until dimensions are non-zero.
  useEffect(() => {
    if (section === 'claude') {
      const active = activeSessionId.value;
      if (active) {
        const cancel = ensureTerminalVisible(active);
        return cancel;
      }
    }
  }, [section]);

  function handleSectionChange(s: Section) {
    setActiveSection(s);
  }

  // ========== New session ==========
  function handleNewSession() {
    if (sessions.value.length >= SESSION_LIMIT) {
      addLocalLog('warn', `Maximum of ${SESSION_LIMIT} sessions reached. Close an existing session to create a new one.`);
      return;
    }
    setNewProjectOpen(true);
  }

  async function handleNewShell() {
    if (sessions.value.length >= SESSION_LIMIT) {
      addLocalLog('warn', `Maximum of ${SESSION_LIMIT} sessions reached. Close an existing session to create a new one.`);
      return;
    }

    const tempId = '__loading_' + Date.now();
    addSession({ id: tempId, type: 'shell', cwd: '/workspace', name: 'Shell', createdAt: Date.now(), loading: true });
    setActiveSessionId(tempId);
    setActiveSection('claude');

    try {
      const res = await apiFetch('/api/console/create-shell', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.error) {
        removeSession(tempId);
        return;
      }
      replaceSession(tempId, {
        id: data.sessionId,
        type: 'shell',
        cwd: data.cwd || '/workspace',
        name: data.name || 'Shell',
        createdAt: Date.now(),
      });
      setActiveSessionId(data.sessionId);
      mountTerminalForSession(data.sessionId, data.cwd || '/workspace', data.name || 'Shell');
    } catch {
      removeSession(tempId);
    }
  }

  async function handleProjectConfirm(dir: string, options: { resume: boolean }) {
    setNewProjectOpen(false);
    if (sessions.value.length >= SESSION_LIMIT) {
      addLocalLog('warn', `Maximum of ${SESSION_LIMIT} sessions reached. Close an existing session to create a new one.`);
      return;
    }

    // Show tab immediately with loading state
    const tempId = '__loading_' + Date.now();
    const folderName = dir.split('/').pop() || dir;
    addSession({ id: tempId, cwd: dir, name: folderName, createdAt: Date.now(), loading: true });
    setActiveSessionId(tempId);

    // Safety timeout: remove loading placeholder if API doesn't respond
    const loadingTimeout = setTimeout(() => removeSession(tempId), 30_000);

    try {
      const res = await apiFetch('/api/console/create', {
        method: 'POST',
        body: JSON.stringify({ cwd: dir, resume: options.resume }),
      });
      clearTimeout(loadingTimeout);
      const data = await res.json();
      if (data.error) {
        removeSession(tempId);
        if (data.error === 'Claude is not authenticated') {
          addLocalLog('error', 'Claude session expired — please re-authenticate');
          setLoginModalOpen(true);
        }
        return;
      }
      // Replace loading placeholder with real session
      replaceSession(tempId, {
        id: data.sessionId,
        cwd: data.cwd || dir,
        name: data.name || folderName,
        createdAt: Date.now(),
      });
      setActiveSessionId(data.sessionId);
      mountTerminalForSession(data.sessionId, data.cwd || dir, data.name);
    } catch {
      clearTimeout(loadingTimeout);
      removeSession(tempId);
    }
  }

  // ========== Render ==========
  if (currentView === 'loading') return <LoadingView />;
  if (currentView === 'auth') return <AuthView onAuth={continueAfterAuth} />;
  if (currentView === 'setup') {
    return (
      <>
        <SetupView onConnect={startLogin} />
        <LoginModal visible={loginModalOpen} onClose={handleLoginClose} onSuccess={handleLoginSuccess} />
      </>
    );
  }
  if (currentView === 'preset') return <PresetWizard onComplete={handlePresetComplete} />;

  // Main view
  return (
    <div class="app-layout">
      <Sidebar onSectionChange={handleSectionChange} mobileOpen={false} onClose={() => {}} collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed(c => !c)} />
      <MobileMenu open={sidebarOpen} onClose={() => setSidebarOpen(false)} onSectionChange={handleSectionChange} />
      <div class="content-area">
        <header class="mobile-header" style={mobileKeyboardOpen.value ? 'display:none' : ''}>
          <button class={`hamburger-btn${sidebarOpen ? ' open' : ''}`} onClick={() => setSidebarOpen(o => !o)} aria-label={sidebarOpen ? 'Close menu' : 'Open menu'} aria-expanded={sidebarOpen}>
            {sidebarOpen ? (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            )}
          </button>
          <div class="mobile-header-brand">
            <IconBridge size={20} />
            <span class="mobile-header-title">Codeck</span>
          </div>
        </header>
        <main id="main-content">
          <ErrorBoundary>
            {section === 'home' && <HomeSection onRelogin={startLogin} onLogout={handleLogout} />}
            {section === 'filesystem' && <FilesSection />}
            {/* ClaudeSection is always mounted — never unmount it.
                Unmounting destroys xterm instances (expensive WebGL teardown + init on remount,
                causes 5-10s input freeze) and loses the attach state (black terminal on return).
                CSS display:none/contents hides/shows it without touching the DOM tree. */}
            <div style={section !== 'claude' ? { display: 'none' } : { display: 'contents' }}>
              <ClaudeSection onNewSession={handleNewSession} onNewShell={handleNewShell} />
            </div>

            {section === 'agents' && <AgentsSection />}
            {section === 'integrations' && <IntegrationsSection />}
            {section === 'config' && <AgentConfigSection />}
            {section === 'settings' && <SettingsSection />}
          </ErrorBoundary>
        </main>
        {!mobileKeyboardOpen.value && section === 'settings' && <LogsDrawer />}
      </div>
      <LoginModal visible={loginModalOpen} onClose={handleLoginClose} onSuccess={handleLoginSuccess} />
      <NewProjectModal visible={newProjectOpen} onCancel={() => setNewProjectOpen(false)} onConfirm={handleProjectConfirm} />
      <ReconnectOverlay />
      <PullToRefresh />
    </div>
  );
}
