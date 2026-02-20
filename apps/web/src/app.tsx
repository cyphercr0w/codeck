import { Component } from 'preact';
import { useEffect, useState, useRef } from 'preact/hooks';
import {
  view, activeSection, claudeAuthenticated, presetConfigured, isMobile,
  updateStateFromServer, setView, setActiveSection, setAuthMode, setActiveSessionId,
  setPresetConfigured, setAccountInfo,
  sessions, activeSessionId, addSession, removeSession, replaceSession,
  addLocalLog,
  type View, type Section,
} from './state/store';
import { apiFetch, getAuthToken, clearAuthToken } from './api';
import { connectWebSocket } from './ws';
import { fitTerminal, scrollToBottom } from './terminal';
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
import { ConfigSection } from './components/ConfigSection';

import { AgentsSection } from './components/AgentsSection';
import { SettingsSection } from './components/SettingsSection';
import { MobileMenu } from './components/MobileMenu';
import { IconBridge } from './components/Icons';
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

const MAX_INIT_RETRIES = 5;
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

  // iOS Safari: prevent pull-to-refresh and scroll chaining.
  // overscroll-behavior: none is not supported in Safari, so we use a
  // touchmove handler as a cross-browser fallback.
  useEffect(() => {
    if (!isMobile.value) return;
    const preventPullToRefresh = (e: TouchEvent) => {
      // Only prevent when at top of page (pull-to-refresh trigger zone)
      if (window.scrollY === 0 && e.touches[0]?.clientY > 0) {
        const target = e.target as HTMLElement | null;
        // Allow scrolling inside elements with overflow (e.g., terminal viewport)
        if (target?.closest('.xterm-viewport, .scrollable')) return;
        e.preventDefault();
      }
    };
    document.body.addEventListener('touchmove', preventPullToRefresh, { passive: false });
    return () => document.body.removeEventListener('touchmove', preventPullToRefresh);
  }, []);

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

  // ========== Initialization ==========
  const initRetryCount = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    initializeApp(controller.signal);
    return () => controller.abort();
  }, []);

  async function initializeApp(signal?: AbortSignal) {
    setView('loading');

    try {
      // Check password auth
      const authRes = await fetch('/api/auth/status', { signal });
      if (!authRes.ok) throw new Error(`Auth status check failed: ${authRes.status}`);
      const authData = await authRes.json();

      if (authData.configured) {
        const token = getAuthToken();
        if (!token) {
          setView('auth');
          setAuthMode('login');
          return;
        }
        try {
          const testRes = await apiFetch('/api/status', { signal });
          if (testRes.status === 401) {
            setView('auth');
            setAuthMode('login');
            return;
          }
          const data = await testRes.json();
          updateStateFromServer(data);
        } catch (e: any) {
          if (e?.name === 'AbortError') return;
          return; // apiFetch handles 401 redirect
        }
      } else {
        // Server says password not configured. If we have a stale token, clear it
        // so we don't confuse the user — they need to set up the password again.
        const existingToken = getAuthToken();
        if (existingToken) {
          console.warn('[Init] Server reports unconfigured but we have a stored token — clearing stale token');
          clearAuthToken();
        }
        setView('auth');
        setAuthMode('setup');
        return;
      }

      // Claude check
      initRetryCount.current = 0; // Reset on success
      if (claudeAuthenticated.value) {
        await loadAccountInfo(signal);
        if (!presetConfigured.value) {
          setView('preset');
          connectWebSocket();
        } else {
          // Set section from URL BEFORE view transition so the
          // section→URL sync effect doesn't overwrite the pathname.
          setActiveSection(sectionFromUrl());
          setView('main');
          connectWebSocket();
          await restoreSessions();
        }
      } else {
        setView('setup');
        connectWebSocket();
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      setView('setup');

      // Exponential backoff with max retries
      if (initRetryCount.current < MAX_INIT_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, initRetryCount.current), 30000);
        initRetryCount.current++;
        addLocalLog('warn', `Initialization failed, retrying in ${Math.round(delay / 1000)}s (attempt ${initRetryCount.current}/${MAX_INIT_RETRIES})`);
        setTimeout(() => initializeApp(signal), delay);
      } else {
        addLocalLog('error', 'Initialization failed after maximum retries. Please reload the page.');
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
        await loadAccountInfo();
        if (!presetConfigured.value) {
          setView('preset');
          connectWebSocket();
        } else {
          setActiveSection(sectionFromUrl());
          setView('main');
          connectWebSocket();
          await restoreSessions();
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

  async function handleLoginSuccess() {
    setLoginModalOpen(false);
    // Reload status from server and transition
    try {
      const res = await apiFetch('/api/status');
      const data = await res.json();
      updateStateFromServer(data);
    } catch { /* ignore */ }
    await loadAccountInfo();
    if (!presetConfigured.value) {
      setView('preset');
      connectWebSocket();
    } else {
      setActiveSection(sectionFromUrl());
      setView('main');
      connectWebSocket();
      await restoreSessions();
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
  // When section becomes 'claude', refit + scroll all active terminals.
  // This runs for BOTH user navigation (handleSectionChange) and programmatic
  // section changes (e.g. ws.ts calling setActiveSection after session restore).
  // Without this, the terminal canvas stays black after restore because xterm
  // wrote to its buffer while the container was display:none, and no render
  // was triggered when the container became visible again.
  useEffect(() => {
    if (section === 'claude') {
      const active = activeSessionId.value;
      if (active) setTimeout(() => { fitTerminal(active); scrollToBottom(active); }, 50);
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

    try {
      const res = await apiFetch('/api/console/create', {
        method: 'POST',
        body: JSON.stringify({ cwd: dir, resume: options.resume }),
      });
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
        <header class="mobile-header">
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
            {section === 'home' && <HomeSection onRelogin={startLogin} />}
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
            {section === 'config' && <ConfigSection />}
            {section === 'settings' && <SettingsSection />}
          </ErrorBoundary>
        </main>
        <LogsDrawer />
      </div>
      <LoginModal visible={loginModalOpen} onClose={handleLoginClose} onSuccess={handleLoginSuccess} />
      <NewProjectModal visible={newProjectOpen} onCancel={() => setNewProjectOpen(false)} onConfirm={handleProjectConfirm} />
      <ReconnectOverlay />
    </div>
  );
}
