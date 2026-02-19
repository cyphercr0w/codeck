import { useRef } from 'preact/hooks';
import { authMode, view } from '../state/store';
import { setAuthToken } from '../api';
import { IconLock } from './Icons';

interface AuthViewProps {
  onAuth: () => void;
}

export function AuthView({ onAuth }: AuthViewProps) {
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const isSetup = authMode.value === 'setup';

  async function handleSubmit() {
    const password = passwordRef.current?.value || '';
    if (errorRef.current) errorRef.current.textContent = '';

    if (isSetup) {
      const confirm = confirmRef.current?.value || '';
      if (!password || password.length < 8) {
        if (errorRef.current) errorRef.current.textContent = 'Password must be at least 8 characters';
        return;
      }
      if (password.length > 256) {
        if (errorRef.current) errorRef.current.textContent = 'Password must not exceed 256 characters';
        return;
      }
      if (password !== confirm) {
        if (errorRef.current) errorRef.current.textContent = 'Passwords do not match';
        return;
      }
      try {
        const res = await fetch('/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        const data = await res.json();
        if (data.success) {
          setAuthToken(data.token);
          onAuth();
        } else {
          if (errorRef.current) errorRef.current.textContent = data.error || 'Error setting password';
        }
      } catch {
        if (errorRef.current) errorRef.current.textContent = 'Connection error';
      }
    } else {
      if (!password) {
        if (errorRef.current) errorRef.current.textContent = 'Password required';
        return;
      }
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        const data = await res.json();
        if (data.success) {
          setAuthToken(data.token);
          onAuth();
        } else {
          if (errorRef.current) errorRef.current.textContent = data.error || 'Incorrect password';
        }
      } catch {
        if (errorRef.current) errorRef.current.textContent = 'Connection error';
      }
    }
  }

  function handlePasswordKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      if (isSetup) confirmRef.current?.focus();
      else handleSubmit();
    }
  }

  function handleConfirmKey(e: KeyboardEvent) {
    if (e.key === 'Enter') handleSubmit();
  }

  // When the virtual keyboard opens it overlays content (interactive-widget=overlays-content).
  // Scroll the focused input into the visible area after the keyboard finishes animating.
  function handleFocus(e: FocusEvent) {
    setTimeout(() => {
      (e.target as HTMLElement)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 350);
  }

  return (
    <div class="view-setup">
      <div class="setup-card">
        <div class="setup-logo"><IconLock size={48} /></div>
        <div class="setup-title">{isSetup ? 'Set Password' : 'Login'}</div>
        <div class="setup-desc">
          {isSetup
            ? 'Create a password to protect your sandbox.'
            : 'Enter your password to access the sandbox.'}
        </div>
        <div class="mb-16">
          <input
            type="password"
            class="input"
            ref={passwordRef}
            placeholder={isSetup ? 'Password (min 8 characters)' : 'Password'}
            autocomplete={isSetup ? 'new-password' : 'current-password'}
            onKeyDown={handlePasswordKey}
          onFocus={handleFocus}
          />
        </div>
        {isSetup && (
          <div class="mb-16">
            <input
              type="password"
              class="input"
              ref={confirmRef}
              placeholder="Confirm password"
              autocomplete="new-password"
              onKeyDown={handleConfirmKey}
            onFocus={handleFocus}
            />
          </div>
        )}
        <button class="btn btn-primary btn-full" style={{ padding: '14px', fontSize: '15px' }} onClick={handleSubmit}>
          {isSetup ? 'Set Password' : 'Login'}
        </button>
        <div ref={errorRef} class="text-sm text-error" style={{ marginTop: '12px' }} />
      </div>
    </div>
  );
}
