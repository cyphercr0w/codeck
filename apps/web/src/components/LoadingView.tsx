import { IconBridge } from './Icons';

export function LoadingView() {
  return (
    <div class="view-loading">
      <div class="loading-brand">
        <IconBridge size={48} />
      </div>
      <div class="loading-brand-name">Codeck</div>
      <div class="loading-text">Checking credentials...</div>
    </div>
  );
}
