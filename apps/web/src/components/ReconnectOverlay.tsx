import { useEffect, useState } from 'preact/hooks';
import { wsConnected } from '../state/store';

// Only show the overlay after a sustained disconnect — brief reconnects
// (< DELAY_MS) are invisible to the user, avoiding input disruption.
const DELAY_MS = 1500;
// Show retry button after this many seconds of visible overlay
const RETRY_DELAY_MS = 5000;

export function ReconnectOverlay() {
  const [visible, setVisible] = useState(false);
  const [showRetry, setShowRetry] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let hasConnectedOnce = false;

    const unsub = wsConnected.subscribe(connected => {
      // Always clear previous timers on any state change
      if (timer) clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
      timer = null;
      retryTimer = null;

      if (connected) {
        hasConnectedOnce = true;
        setVisible(false);
        setShowRetry(false);
      } else if (hasConnectedOnce) {
        // Only show overlay after a REAL disconnect (not the initial load)
        setShowRetry(false);
        timer = setTimeout(() => {
          setVisible(true);
          retryTimer = setTimeout(() => setShowRetry(true), RETRY_DELAY_MS);
        }, DELAY_MS);
      }
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  if (!visible) return null;

  return (
    <div class="reconnect-overlay">
      <div class="reconnect-content">
        <div class="loading" />
        <div class="reconnect-text">Reconnecting...</div>
        {showRetry && (
          <button
            class="reconnect-retry-btn"
            onClick={async () => {
              // Unregister SW and force fresh reload
              if ('serviceWorker' in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(r => r.unregister()));
              }
              window.location.href = window.location.pathname + '?_=' + Date.now();
            }}
          >
            Reload page
          </button>
        )}
      </div>
    </div>
  );
}
