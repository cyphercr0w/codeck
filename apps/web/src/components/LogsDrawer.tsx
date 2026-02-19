import { useEffect, useRef } from 'preact/hooks';
import { logs, logsExpanded, clearLogs } from '../state/store';
import { IconChevronUp, IconChevronDown } from './Icons';

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function LogsDrawer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const expanded = logsExpanded.value;
  const logEntries = logs.value;

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logEntries.length]);

  function toggle() {
    logsExpanded.value = !logsExpanded.value;
  }

  function handleClear(e: Event) {
    e.stopPropagation();
    clearLogs();
  }

  return (
    <aside class={`logs-drawer ${expanded ? 'expanded' : 'collapsed'}`} aria-label="Application logs">
      <div class="logs-drawer-header" onClick={toggle} role="button" tabIndex={0} aria-expanded={expanded} aria-label={`Logs (${logEntries.length})`} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
        <span class="logs-drawer-title">
          Logs
          <span class="logs-drawer-badge" aria-hidden="true">{logEntries.length}</span>
        </span>
        <div class="logs-drawer-actions">
          <button
            class="btn btn-sm btn-ghost"
            style={{ padding: '2px 8px', fontSize: '11px' }}
            onClick={handleClear}
            aria-label="Clear logs"
          >
            Clear
          </button>
          <span class="logs-drawer-toggle" aria-hidden="true">
            {expanded ? <IconChevronDown size={14} /> : <IconChevronUp size={14} />}
          </span>
        </div>
      </div>
      <div class="logs-container" ref={containerRef} role="log" aria-live="polite">
        {logEntries.length === 0 && (
          <div class="log-empty">Logs will appear here...</div>
        )}
        {logEntries.map((entry, i) => {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          return (
            <div key={i} class={`log-entry${entry.type === 'error' ? ' error' : ''}`}>
              <span class={`log-dot ${entry.type}`} />
              <span class="log-time">{time}</span>
              <span dangerouslySetInnerHTML={{ __html: escapeHtml(entry.message) }} />
            </div>
          );
        })}
      </div>
    </aside>
  );
}
