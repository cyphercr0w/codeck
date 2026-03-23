import { toasts, dismissToast } from '../state/store';
import { IconX, IconCheck } from './Icons';

export function ToastContainer() {
  const items = toasts.value;
  if (items.length === 0) return null;

  return (
    <div class="toast-container">
      {items.map(t => (
        <div key={t.id} class={`toast toast-${t.type}`}>
          <span class="toast-icon">
            {t.type === 'error' ? '!' : t.type === 'info' ? 'ⓘ' : <IconCheck size={14} />}
          </span>
          <span class="toast-msg">{t.message}</span>
          <button class="toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <IconX size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
