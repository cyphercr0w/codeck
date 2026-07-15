import { useState } from 'preact/hooks';
import { workspacePath, type ProactiveAgent } from '../../state/store';
import { IconChevronDown, IconChevronUp } from '../Icons';
import { DirSelector } from './DirSelector';

const SCHEDULE_PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6h', cron: '0 */6 * * *' },
  { label: 'Daily 9am', cron: '0 9 * * *' },
  { label: 'Weekdays 9am', cron: '0 9 * * 1-5' },
  { label: 'Weekly', cron: '0 9 * * 1' },
];

const MODEL_OPTIONS = [
  { label: 'Default (Sonnet)', value: '' },
  { label: 'Opus 4.8', value: 'opus' },
  { label: 'Sonnet 5', value: 'sonnet' },
  { label: 'Fable 5', value: 'fable' },
  { label: 'Haiku 4.5', value: 'haiku' },
];

export function AgentForm({ initial, onSubmit, onCancel, submitLabel, submitting }: {
  initial?: Partial<ProactiveAgent>;
  onSubmit: (data: Record<string, unknown>) => void;
  onCancel: () => void;
  submitLabel: string;
  submitting: boolean;
}) {
  const [name, setName] = useState(initial?.name || '');
  const [objective, setObjective] = useState(initial?.objective || '');
  const [schedule, setSchedule] = useState(initial?.schedule || '0 * * * *');
  const [customCron, setCustomCron] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(!!initial);
  const [cwd, setCwd] = useState(initial?.cwd || workspacePath.value);
  const [model, setModel] = useState(initial?.model || '');
  const [timeoutMin, setTimeoutMin] = useState(initial?.timeoutMs ? Math.round(initial.timeoutMs / 60000) : 5);
  const [maxRetries, setMaxRetries] = useState(initial?.maxRetries || 3);
  const [error, setError] = useState('');

  const isPreset = SCHEDULE_PRESETS.some(p => p.cron === schedule);
  const selectedCron = customCron || schedule;

  function handleSubmit() {
    if (!name.trim() || !objective.trim()) {
      setError('Name and objective are required');
      return;
    }
    setError('');
    onSubmit({
      name: name.trim(),
      objective: objective.trim(),
      schedule: selectedCron,
      cwd: cwd.trim() || workspacePath.value,
      model,
      timeoutMs: timeoutMin * 60000,
      maxRetries,
    });
  }

  return (
    <>
      <div class="form-group">
        <label class="form-label">Name</label>
        <input
          type="text"
          class="input"
          value={name}
          onInput={e => setName((e.target as HTMLInputElement).value)}
          placeholder="e.g. Test Runner"
          maxLength={50}
        />
      </div>

      <div class="form-group">
        <label class="form-label">Objective</label>
        <textarea
          class="input"
          value={objective}
          onInput={e => setObjective((e.target as HTMLTextAreaElement).value)}
          placeholder="e.g. Run the test suite, fix any failures, and commit the fixes"
          rows={3}
          style="resize: vertical; min-height: 60px"
        />
      </div>

      <div class="form-group">
        <label class="form-label">Schedule <span style="opacity: 0.5; font-size: 0.9em">(UTC)</span></label>
        <div class="schedule-presets">
          {SCHEDULE_PRESETS.map(p => (
            <button
              key={p.cron}
              class={`btn btn-xs ${schedule === p.cron && !customCron ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { setSchedule(p.cron); setCustomCron(''); }}
              type="button"
            >
              {p.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          class="input"
          value={customCron || (!isPreset && initial ? schedule : '')}
          onInput={e => setCustomCron((e.target as HTMLInputElement).value)}
          placeholder="Custom cron (e.g. */5 * * * *)"
        />
      </div>

      <button
        class="btn btn-xs btn-ghost"
        style="margin-bottom: 12px"
        onClick={() => setShowAdvanced(!showAdvanced)}
        type="button"
      >
        {showAdvanced ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
        {showAdvanced ? 'Hide' : 'Show'} Advanced
      </button>

      {showAdvanced && (
        <>
          <div class="form-group">
            <label class="form-label">Working Directory</label>
            <DirSelector value={cwd} onChange={setCwd} />
          </div>
          <div class="form-group">
            <label class="form-label">Model</label>
            <select class="input" value={model} onChange={e => setModel((e.target as HTMLSelectElement).value)}>
              {MODEL_OPTIONS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Timeout (minutes)</label>
              <input
                type="number"
                class="input"
                value={timeoutMin}
                onInput={e => setTimeoutMin(parseInt((e.target as HTMLInputElement).value) || 5)}
                min={1}
                max={60}
              />
            </div>
            <div class="form-group">
              <label class="form-label">Max Retries</label>
              <input
                type="number"
                class="input"
                value={maxRetries}
                onInput={e => setMaxRetries(parseInt((e.target as HTMLInputElement).value) || 3)}
                min={1}
                max={10}
              />
            </div>
          </div>
        </>
      )}

      {error && <div class="alert alert-error" style="margin-bottom: 12px">{error}</div>}

      <div class="modal-actions">
        <button class="btn btn-sm btn-secondary" onClick={onCancel} type="button">Cancel</button>
        <button class="btn btn-sm btn-primary" onClick={handleSubmit} disabled={submitting} type="button">
          {submitting ? <><span class="loading" /> {submitLabel}...</> : submitLabel}
        </button>
      </div>
    </>
  );
}
