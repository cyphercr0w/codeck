import { useState, useEffect } from 'preact/hooks';
import { apiFetch, setAuthToken } from '../api';

// ── Types ──────────────────────────────────────────────────────────────────

interface SessionInfo {
  id: string;
  createdAt: number;
  expiresAt: number;
  ip: string;
  current: boolean;
}

interface AuthLogEntry {
  type: 'login_success' | 'login_failure';
  ip: string;
  timestamp: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

function expiresIn(expiresAt: number): { label: string; urgent: boolean } {
  const diff = Math.floor((expiresAt - Date.now()) / 1000);
  if (diff <= 0) return { label: 'Expired', urgent: true };
  if (diff < 3600) return { label: `${Math.floor(diff / 60)}m`, urgent: true };
  if (diff < 86400) return { label: `${Math.floor(diff / 3600)}h`, urgent: true };
  return { label: `${Math.floor(diff / 86400)}d`, urgent: false };
}

// ── Change Password Card ───────────────────────────────────────────────────

function ChangePasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    setError('');
    setSuccess(false);

    if (next.length < 8) { setError('New password must be at least 8 characters.'); return; }
    if (next !== confirm) { setError('Passwords do not match.'); return; }

    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json();
      if (data.success && data.token) {
        setAuthToken(data.token);
        setSuccess(true);
        setCurrent('');
        setNext('');
        setConfirm('');
      } else {
        setError(data.error || 'Failed to change password.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div class="settings-card">
      <div class="settings-card-title">Change Password</div>
      <form onSubmit={handleSubmit}>
        <div class="settings-form-group">
          <label>Current password</label>
          <input
            type="password"
            class="input-field"
            value={current}
            onInput={(e) => setCurrent((e.target as HTMLInputElement).value)}
            required
            autocomplete="current-password"
          />
        </div>
        <div class="settings-form-group">
          <label>New password</label>
          <input
            type="password"
            class="input-field"
            value={next}
            onInput={(e) => setNext((e.target as HTMLInputElement).value)}
            required
            minLength={8}
            autocomplete="new-password"
          />
        </div>
        <div class="settings-form-group">
          <label>Confirm new password</label>
          <input
            type="password"
            class="input-field"
            value={confirm}
            onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
            required
            autocomplete="new-password"
          />
        </div>
        {error && <div class="settings-error">{error}</div>}
        {success && <div class="settings-success">Password updated successfully.</div>}
        <button type="submit" class="btn-primary" disabled={loading}>
          {loading ? 'Saving...' : 'Change Password'}
        </button>
      </form>
    </div>
  );
}

// ── Active Sessions Card ───────────────────────────────────────────────────

function ActiveSessionsCard() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);

  async function loadSessions() {
    try {
      const res = await apiFetch('/api/auth/sessions');
      const data = await res.json();
      const now = Date.now();
      setSessions((data.sessions || []).filter((s: SessionInfo) => s.expiresAt > now));
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadSessions(); }, []);

  async function revoke(id: string) {
    setRevoking(id);
    try {
      await apiFetch(`/api/auth/sessions/${id}`, { method: 'DELETE' });
      setSessions(s => s.filter(x => x.id !== id));
    } catch {
      // ignore
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div class="settings-card">
      <div class="settings-card-title">Active Sessions</div>
      {loading ? (
        <div class="settings-muted">Loading...</div>
      ) : sessions.length === 0 ? (
        <div class="settings-muted">No active sessions.</div>
      ) : (
        <div class="settings-table-wrap">
          <table class="settings-table">
            <thead>
              <tr>
                <th>IP</th>
                <th>Created</th>
                <th>Expires</th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map(s => {
                const exp = expiresIn(s.expiresAt);
                return (
                  <tr key={s.id}>
                    <td>{s.ip}</td>
                    <td title={absoluteTime(s.createdAt)}>{relativeTime(s.createdAt)}</td>
                    <td title={absoluteTime(s.expiresAt)}>
                      <span class={exp.urgent ? 'settings-expires-urgent' : ''}>
                        {exp.label}
                      </span>
                    </td>
                    <td>
                      {s.current && <span class="settings-badge">Current</span>}
                    </td>
                    <td>
                      <button
                        class="btn-danger-sm"
                        disabled={s.current || revoking === s.id}
                        onClick={() => revoke(s.id)}
                      >
                        {revoking === s.id ? '...' : 'Revoke'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Auth Log Card ──────────────────────────────────────────────────────────

function AuthLogCard() {
  const [events, setEvents] = useState<AuthLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch('/api/auth/log')
      .then(r => r.json())
      .then(d => setEvents((d.events || []).slice().reverse()))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div class="settings-card">
      <div class="settings-card-title">Authentication Log</div>
      {loading ? (
        <div class="settings-muted">Loading...</div>
      ) : events.length === 0 ? (
        <div class="settings-muted">No authentication events.</div>
      ) : (
        <div class="settings-table-wrap">
          <table class="settings-table">
            <thead>
              <tr>
                <th>Result</th>
                <th>IP</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td>
                    {e.type === 'login_success'
                      ? <span class="settings-log-ok">Success</span>
                      : <span class="settings-log-fail">Failed</span>
                    }
                  </td>
                  <td>{e.ip}</td>
                  <td title={absoluteTime(e.timestamp)}>{relativeTime(e.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────

export function SettingsSection() {
  return (
    <div class="settings-content">
      <ChangePasswordCard />
      <ActiveSessionsCard />
      <AuthLogCard />
    </div>
  );
}
