import { agentName } from '../state/store';
import { IconBridge } from './Icons';

interface SetupViewProps {
  onConnect: () => void;
}

export function SetupView({ onConnect }: SetupViewProps) {
  return (
    <div class="view-setup">
      <div class="setup-card">
        <div class="setup-logo"><IconBridge size={48} /></div>
        <div class="setup-title">Codeck</div>
        <div class="setup-desc">Connect your Anthropic account to start using {agentName.value} Code in the sandbox.</div>
        <button
          class="btn btn-primary btn-full"
          style={{ padding: '14px', fontSize: '15px' }}
          onClick={onConnect}
        >
          Connect {agentName.value} Account
        </button>
      </div>
    </div>
  );
}
