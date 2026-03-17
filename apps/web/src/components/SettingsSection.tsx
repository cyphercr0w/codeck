import { useState, useEffect } from 'preact/hooks';
import { apiFetch, setAuthToken } from '../api';
import { IconShield, IconKey, IconList } from './Icons';

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
    <div class="dash-card">
      <div class="dash-card-title">
        <IconKey size={14} />
        <span>Change Password</span>
      </div>
      <form onSubmit={handleSubmit}>
        <div class="form-group">
          <label class="form-label">Current password</label>
          <input
            type="password"
            class="input"
            value={current}
            onInput={(e) => setCurrent((e.target as HTMLInputElement).value)}
            required
            autocomplete="current-password"
          />
        </div>
        <div class="form-group">
          <label class="form-label">New password</label>
          <input
            type="password"
            class="input"
            value={next}
            onInput={(e) => setNext((e.target as HTMLInputElement).value)}
            required
            minLength={8}
            autocomplete="new-password"
          />
        </div>
        <div class="form-group">
          <label class="form-label">Confirm new password</label>
          <input
            type="password"
            class="input"
            value={confirm}
            onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
            required
            autocomplete="new-password"
          />
        </div>
        {error && <div class="alert alert-error" style="margin-bottom: 12px">{error}</div>}
        {success && <div class="form-success">Password updated successfully.</div>}
        <button type="submit" class="btn btn-sm btn-primary" disabled={loading}>
          {loading ? <><span class="loading" /> Saving...</> : 'Change Password'}
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
    <div class="dash-card">
      <div class="dash-card-title">
        <IconShield size={14} />
        <span>Active Sessions</span>
      </div>
      {loading ? (
        <div class="dash-loading"><span class="loading" /> Loading...</div>
      ) : sessions.length === 0 ? (
        <div class="dash-meta" style="border-top: none; margin-top: 0; padding-top: 0">No active sessions.</div>
      ) : (
        <div class="dash-table-wrap">
          <table class="dash-table">
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
                    <td><code>{s.ip}</code></td>
                    <td title={absoluteTime(s.createdAt)}>{relativeTime(s.createdAt)}</td>
                    <td title={absoluteTime(s.expiresAt)}>
                      <span class={exp.urgent ? 'text-error' : ''}>
                        {exp.label}
                      </span>
                    </td>
                    <td>
                      {s.current && <span class="badge badge-success">Current</span>}
                    </td>
                    <td>
                      <button
                        class="btn btn-xs btn-ghost danger"
                        disabled={s.current || revoking === s.id}
                        onClick={() => revoke(s.id)}
                      >
                        {revoking === s.id ? <span class="loading" /> : 'Revoke'}
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
    <div class="dash-card">
      <div class="dash-card-title">
        <IconList size={14} />
        <span>Authentication Log</span>
      </div>
      {loading ? (
        <div class="dash-loading"><span class="loading" /> Loading...</div>
      ) : events.length === 0 ? (
        <div class="dash-meta" style="border-top: none; margin-top: 0; padding-top: 0">No authentication events.</div>
      ) : (
        <div class="dash-table-wrap">
          <table class="dash-table">
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
                      ? <span class="badge badge-success">Success</span>
                      : <span class="badge badge-error">Failed</span>
                    }
                  </td>
                  <td><code>{e.ip}</code></td>
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
    <div class="content-section">
      <div class="home-content">
        <div class="home-header">
          <div class="home-title">
            <IconShield size={20} />
            <span>Settings</span>
          </div>
        </div>
        <div class="dash-grid">
          <ChangePasswordCard />
          <ActiveSessionsCard />
        </div>
        <div style="margin-top: 16px">
          <AuthLogCard />
        </div>
      </div>
    </div>
  );
}
