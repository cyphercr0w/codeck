import { useState, useEffect } from 'preact/hooks';
import { apiFetch } from '../api';
import { IconBridge } from './Icons';

interface PresetManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  icon: string;
  tags: string[];
}

interface PresetWizardProps {
  onComplete: () => void;
}

export function PresetWizard({ onComplete }: PresetWizardProps) {
  const [presets, setPresets] = useState<PresetManifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadPresets();
  }, []);

  async function loadPresets() {
    try {
      const res = await apiFetch('/api/presets');
      const data = await res.json();
      setPresets(data);
    } catch {
      setError('Failed to load presets');
    } finally {
      setLoading(false);
    }
  }

  async function apply(presetId: string) {
    setSelected(presetId);
    setApplying(true);
    setError(null);

    try {
      const res = await apiFetch('/api/presets/apply', {
        method: 'POST',
        body: JSON.stringify({ presetId }),
      });
      const data = await res.json();
      if (data.success) {
        onComplete();
      } else {
        setError(data.error || 'Error applying preset');
        setApplying(false);
      }
    } catch {
      setError('Connection error');
      setApplying(false);
    }
  }

  const isRecommended = (preset: PresetManifest) => preset.tags.includes('recommended');

  return (
    <div class="view-preset">
      <div class="preset-header">
        <div class="preset-logo"><IconBridge size={48} /></div>
        <h1 class="preset-title">Configure Workspace</h1>
        <p class="preset-subtitle">Choose how your workspace should be set up.</p>
      </div>

      {loading && (
        <div class="preset-progress">
          <div class="spinner" />
          <span>Loading presets...</span>
        </div>
      )}

      {!loading && presets.length > 0 && (
        <div class="preset-cards">
          {presets.map(preset => (
            <div
              key={preset.id}
              class={`preset-card ${selected === preset.id ? 'preset-card--selected' : ''}`}
              onClick={() => !applying && apply(preset.id)}
            >
              {isRecommended(preset) && <div class="preset-card-badge">Recommended</div>}
              <div class="preset-card-icon">{preset.icon}</div>
              <h2 class="preset-card-title">{preset.name}</h2>
              <p class="preset-card-desc">{preset.description}</p>
              <button
                class={`btn ${isRecommended(preset) ? 'btn-primary' : 'btn-secondary'} btn-full`}
                disabled={applying}
                onClick={(e) => { e.stopPropagation(); apply(preset.id); }}
              >
                {applying && selected === preset.id ? 'Configuring...' : 'Configure'}
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <div class="preset-error">{error}</div>}

      {applying && (
        <div class="preset-progress">
          <div class="spinner" />
          <span>Setting up workspace...</span>
        </div>
      )}
    </div>
  );
}
