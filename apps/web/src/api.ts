import { setView, setAuthMode } from './state/store';

const TOKEN_KEY = 'codeck_auth_token';

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// Cross-tab auth state synchronization via storage events
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === TOKEN_KEY && e.storageArea === localStorage) {
      if (e.newValue === null) {
        // Token removed in another tab (logout) — sync logout
        setView('auth');
        setAuthMode('login');
      }
    }
  });
}

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    clearAuthToken();
    setView('auth');
    setAuthMode('login');
    throw new Error('Unauthorized');
  }
  return res;
}
