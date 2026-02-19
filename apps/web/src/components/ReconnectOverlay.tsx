import { wsConnected } from '../state/store';

export function ReconnectOverlay() {
  if (wsConnected.value) return null;

  return (
    <div class="reconnect-overlay">
      <div class="reconnect-content">
        <div class="loading" />
        <div class="reconnect-text">Reconnecting...</div>
      </div>
    </div>
  );
}
