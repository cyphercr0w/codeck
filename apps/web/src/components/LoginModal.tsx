import { useRef, useState, useEffect } from 'preact/hooks';
import { claudeAuthenticated, addLocalLog, agentName } from '../state/store';
import { apiFetch } from '../api';
import { IconLock } from './Icons';

interface LoginModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

function cleanAuthCode(code: string): string {
  let cleaned = code
    .replace(/Pasteco.*$/gi, '')
    .replace(/Pastecodehereifprompted/gi, '')
    .replace(/paste\s*code\s*here/gi, '')
    .trim();

  const hashIndex = cleaned.indexOf('#');
  if (hashIndex > 0) {
    const afterHash = cleaned.substring(hashIndex + 1);
    const secondHashIndex = afterHash.indexOf('#');
    if (secondHashIndex > 0) {
      const fullCode = cleaned.substring(0, hashIndex + 1 + secondHashIndex);
      const secondPart = cleaned.substring(hashIndex + 1 + secondHashIndex);
      if (secondPart.startsWith('#') || cleaned.substring(fullCode.length).includes(cleaned.substring(0, 20))) {
        cleaned = fullCode;
      }
    }
  }

  const match = cleaned.match(/^[A-Za-z0-9_#-]+/);
  return match ? match[0] : cleaned;
}

export function LoginModal({ visible, onClose, onSuccess }: LoginModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [isError, setIsError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [urlReady, setUrlReady] = useState(false);
  const [done, setDone] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (visible) {
      // Don't reset state if we already have a URL (user is coming back from claude.ai)
      if (!urlReady && !loginUrl) {
        setStatus('');
        setIsError(false);
        setSubmitting(false);
        setDone(false);
        startLogin();
      }

      // Focus trap and Escape handler
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') { handleCancel(); return; }
        if (e.key === 'Tab') {
          const focusableEls = modalRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
          );
          if (!focusableEls || focusableEls.length === 0) return;
          const firstEl = focusableEls[0];
          const lastEl = focusableEls[focusableEls.length - 1];
          if (e.shiftKey && document.activeElement === firstEl) {
            e.preventDefault();
            lastEl.focus();
          } else if (!e.shiftKey && document.activeElement === lastEl) {
            e.preventDefault();
            firstEl.focus();
          }
        }
      };
      document.addEventListener('keydown', handleKeyDown);
      return () => {
        document.removeEventListener('keydown', handleKeyDown);
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      };
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [visible]);

  async function startLogin() {
    try {
      const res = await apiFetch('/api/claude/login', { method: 'POST' });
      const data = await res.json();

      if (data.started) {
        addLocalLog('info', 'Claude login started');
        pollLoginStatus();
      } else if (data.inProgress) {
        addLocalLog('info', data.message || 'Login in progress');
        if (data.url) {
          setLoginUrl(data.url);
          setUrlReady(true);
        }
        pollLoginStatus();
      }
    } catch {
      addLocalLog('error', 'Error starting login');
      setStatus('Error starting login');
      setIsError(true);
    }
  }

  function pollLoginStatus() {
    if (pollRef.current) clearInterval(pollRef.current);
    let pollCount = 0;

    pollRef.current = setInterval(async () => {
      pollCount++;
      if (pollCount > 120) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        addLocalLog('error', 'Login timeout');
        onClose();
        return;
      }

      try {
        const res = await apiFetch('/api/claude/login-status');
        const data = await res.json();

        if (data.url && !urlReady) {
          setLoginUrl(data.url);
          setUrlReady(true);
          addLocalLog('info', 'Login URL ready');
        }

        if (data.authenticated && !done) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          claudeAuthenticated.value = true;
          setDone(true);
          setStatus('Authentication successful!');
          setIsError(false);
          addLocalLog('info', 'Claude authenticated (via poll)');
          setTimeout(() => onSuccess(), 800);
          return;
        }

        if (!data.inProgress && !data.authenticated && !data.url && !urlReady) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          addLocalLog('error', 'Login ended without URL');
          onClose();
        }
      } catch { /* ignore */ }
    }, 1500);
  }

  async function handleSubmit() {
    let code = codeRef.current?.value?.trim() || '';
    if (!code || done) return;

    code = cleanAuthCode(code);
    if (!code) { setStatus('Invalid code'); setIsError(true); return; }

    // Stop polling while submitting
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }

    setSubmitting(true);
    setStatus('Sending code...');
    setIsError(false);

    try {
      const res = await apiFetch('/api/claude/login-code', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      const data = await res.json();

      if (data.success) {
        claudeAuthenticated.value = true;
        setDone(true);
        setStatus('Authentication successful!');
        setIsError(false);
        addLocalLog('info', 'Claude authenticated');
        setTimeout(() => onSuccess(), 800);
      } else {
        setStatus(data.error || 'Authentication error');
        setIsError(true);
        setSubmitting(false);
        // Resume polling after error
        pollLoginStatus();
      }
    } catch {
      setStatus('Connection error');
      setIsError(true);
      setSubmitting(false);
      pollLoginStatus();
    }
  }

  function handleCancel() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    apiFetch('/api/claude/login-cancel', { method: 'POST' }).catch(() => {});
    // Reset state so next open starts fresh
    setLoginUrl(null);
    setUrlReady(false);
    setStatus('');
    setIsError(false);
    setSubmitting(false);
    setDone(false);
    onClose();
  }

  if (!visible) return null;

  return (
    <div class="modal-overlay" onClick={handleCancel}>
      <div
        ref={modalRef}
        class="modal"
        style={{ maxWidth: '500px' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="login-modal-title" class="modal-title">
          <IconLock size={20} />
          <span>{agentName.value} Login</span>
        </h2>

        {!urlReady && !isError && (
          <div style={{ textAlign: 'center', padding: '20px' }}>
            <span class="loading" style={{ width: '24px', height: '24px' }} />
            <div class="text-muted" style={{ marginTop: '12px' }}>Getting authentication URL...</div>
          </div>
        )}

        {urlReady && (
          <div>
            <div class="modal-step">
              <span class="modal-step-num">1</span>
              <span>Open the link and authenticate with your Anthropic account:</span>
            </div>
            <div style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '16px', textAlign: 'center', marginBottom: '16px' }}>
              <a
                href={loginUrl || '#'}
                target="_blank"
                rel="noopener"
                class="btn btn-primary btn-full"
                style={{ textDecoration: 'none' }}
              >
                Open {agentName.value} Login
              </a>
            </div>
            <div class="modal-step">
              <span class="modal-step-num">2</span>
              <span>Paste the code that {agentName.value} gives you:</span>
            </div>
            <div style={{ marginBottom: '8px' }}>
              <input
                type="text"
                class="input"
                ref={codeRef}
                placeholder="Paste the code here"
                aria-label="Authentication code"
                style={{ fontFamily: 'var(--font-mono)' }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !submitting && !done) handleSubmit(); }}
              />
            </div>
            <div class="text-muted text-sm" style={{ marginBottom: '16px' }}>
              After authenticating in {agentName.value}, copy the code it shows and paste it here.
            </div>
          </div>
        )}

        {status && (
          <div
            class="text-sm"
            role={isError ? 'alert' : 'status'}
            aria-live="polite"
            style={{
              textAlign: 'center',
              marginBottom: '16px',
              color: isError ? 'var(--error)' : (done ? 'var(--success)' : 'var(--text-muted)'),
              fontWeight: isError ? '600' : 'normal',
            }}
          >
            {status}
          </div>
        )}

        <div class="modal-actions">
          <button class="btn btn-secondary" onClick={handleCancel} disabled={done}>Cancel</button>
          <button class="btn btn-primary" disabled={!urlReady || submitting || done} onClick={handleSubmit}>
            {done ? 'Success!' : submitting ? 'Sending...' : 'Submit Code'}
          </button>
        </div>
      </div>
    </div>
  );
}
