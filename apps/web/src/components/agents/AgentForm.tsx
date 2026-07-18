import { useState } from 'preact/hooks';
import { workspacePath, type ProactiveAgent, type AgentKind, type LoopMode, type PermissionProfile } from '../../state/store';
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
  const initialKind: AgentKind = initial?.kind === 'loop' ? 'loop' : 'oneshot';
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [objective, setObjective] = useState(initial?.objective || '');
  const [schedule, setSchedule] = useState(initial?.schedule || '0 * * * *');
  const [customCron, setCustomCron] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(!!initial);
  const [cwd, setCwd] = useState(initial?.cwd || workspacePath.value);
  const [model, setModel] = useState(initial?.model || '');
  const [timeoutMin, setTimeoutMin] = useState(
    initial?.timeoutMs ? Math.round(initial.timeoutMs / 60000) : (initialKind === 'loop' ? 30 : 5)
  );
  const [maxRetries, setMaxRetries] = useState(initial?.maxRetries || 3);
  const [error, setError] = useState('');

  // ── Loop mode (full-harness scheduled loop) ──
  const [kind, setKind] = useState<AgentKind>(initialKind);
  const [goal, setGoal] = useState(initial?.loop?.goal || '');
  const [verifyCmd, setVerifyCmd] = useState(initial?.loop?.verifyCmd || '');
  const [loopMode, setLoopMode] = useState<LoopMode>(initial?.loop?.mode || 'scheduled');
  const [permissionProfile, setPermissionProfile] = useState<PermissionProfile>(initial?.loop?.permissionProfile || 'safe-write');
  const [iterCap, setIterCap] = useState(initial?.loop?.iterCap || 200);
  const [costCapUsd, setCostCapUsd] = useState(initial?.loop?.costCapUsd || 5);
  const isLoop = kind === 'loop';

  const isPreset = SCHEDULE_PRESETS.some(p => p.cron === schedule);
  const selectedCron = customCron || schedule;

  function handleSubmit() {
    if (!name.trim() || !objective.trim()) {
      setError('Name and objective are required');
      return;
    }
    if (isLoop && (!goal.trim() || !verifyCmd.trim())) {
      setError('Loops require a goal and a verify command (a machine gate that returns pass/fail)');
      return;
    }
    setError('');
    const payload: Record<string, unknown> = {
      name: name.trim(),
      objective: objective.trim(),
      schedule: selectedCron,
      cwd: cwd.trim() || workspacePath.value,
      model,
      timeoutMs: timeoutMin * 60000,
      maxRetries,
    };
    if (isLoop) {
      payload.loop = {
        goal: goal.trim(),
        verifyCmd: verifyCmd.trim(),
        mode: loopMode,
        permissionProfile,
        iterCap,
        costCapUsd,
      };
      // kind is immutable — only send it when creating.
      if (!isEdit) payload.kind = 'loop';
    } else if (!isEdit) {
      payload.kind = 'oneshot';
    }
    onSubmit(payload);
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
        <label class="form-label">Type</label>
        <div class="schedule-presets">
          <button
            type="button"
            class={`btn btn-xs ${!isLoop ? 'btn-primary' : 'btn-secondary'}`}
            disabled={isEdit}
            onClick={() => setKind('oneshot')}
          >
            Standard (one-shot)
          </button>
          <button
            type="button"
            class={`btn btn-xs ${isLoop ? 'btn-primary' : 'btn-secondary'}`}
            disabled={isEdit}
            onClick={() => { setKind('loop'); if (timeoutMin <= 5) setTimeoutMin(30); }}
          >
            Loop (verified)
          </button>
        </div>
        <div style="opacity: 0.6; font-size: 0.85em; margin-top: 4px">
          {isLoop
            ? 'Each tick runs the full PO-driven harness: plan → implement → review → audit → evidence-gated done, capped by budget.'
            : 'A single Claude run of the objective on each schedule tick.'}
          {isEdit ? ' Type is fixed after creation.' : ''}
        </div>
      </div>

      {isLoop && (
        <>
          <div class="form-group">
            <label class="form-label">Goal <span style="opacity: 0.5; font-size: 0.9em">(observable stop condition)</span></label>
            <input
              type="text"
              class="input"
              value={goal}
              onInput={e => setGoal((e.target as HTMLInputElement).value)}
              placeholder="e.g. All tests in test/auth pass and lint is clean"
              maxLength={2000}
            />
          </div>
          <div class="form-group">
            <label class="form-label">Verify command <span style="opacity: 0.5; font-size: 0.9em">(machine gate — returns pass/fail)</span></label>
            <input
              type="text"
              class="input"
              value={verifyCmd}
              onInput={e => setVerifyCmd((e.target as HTMLInputElement).value)}
              placeholder="e.g. npm test && npm run lint"
              maxLength={1000}
            />
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Loop mode</label>
              <select class="input" value={loopMode} onChange={e => setLoopMode((e.target as HTMLSelectElement).value as LoopMode)}>
                <option value="scheduled">Scheduled (one tick per cron)</option>
                <option value="goal-driven">Goal-driven (self-continue to gate)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Permissions</label>
              <select class="input" value={permissionProfile} onChange={e => setPermissionProfile((e.target as HTMLSelectElement).value as PermissionProfile)}>
                <option value="readonly">Read-only</option>
                <option value="safe-write">Safe-write (local edits/commits)</option>
                <option value="full">Full (push/PR allowed)</option>
              </select>
            </div>
          </div>
        </>
      )}

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
                onInput={e => setTimeoutMin(parseInt((e.target as HTMLInputElement).value) || (isLoop ? 30 : 5))}
                min={1}
                max={isLoop ? 120 : 60}
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
          {isLoop && (
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Iteration cap</label>
                <input
                  type="number"
                  class="input"
                  value={iterCap}
                  onInput={e => setIterCap(parseInt((e.target as HTMLInputElement).value) || 200)}
                  min={1}
                  max={1000}
                />
              </div>
              <div class="form-group">
                <label class="form-label">Cost cap (USD)</label>
                <input
                  type="number"
                  class="input"
                  value={costCapUsd}
                  onInput={e => setCostCapUsd(parseFloat((e.target as HTMLInputElement).value) || 5)}
                  min={0.5}
                  max={100}
                  step={0.5}
                />
              </div>
            </div>
          )}
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
