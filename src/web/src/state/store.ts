import { signal, computed } from '@preact/signals';

// Mobile detection: feature-based (NOT UA sniffing).
// Uses pointer capability + touch support + screen size to identify mobile devices.
// A desktop user with a small browser window is NOT mobile (requires coarse pointer).
function detectMobile(): boolean {
  const hasCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const hasTouch = navigator.maxTouchPoints > 0;
  const isSmallScreen = window.matchMedia('(max-width: 1100px)').matches;
  return hasCoarsePointer && hasTouch && isSmallScreen;
}

export const isMobile = signal(detectMobile());

// Reactively update isMobile when pointer capability or screen size changes
// (e.g., device rotation, toggling mobile emulation in DevTools).
if (typeof window !== 'undefined') {
  const pointerMq = window.matchMedia('(pointer: coarse)');
  const screenMq = window.matchMedia('(max-width: 1100px)');
  const updateMobile = () => { isMobile.value = detectMobile(); };
  pointerMq.addEventListener('change', updateMobile);
  screenMq.addEventListener('change', updateMobile);
}

export type View = 'loading' | 'auth' | 'setup' | 'preset' | 'main';
export type Section = 'home' | 'filesystem' | 'claude' | 'agents' | 'integrations' | 'config';
export type AuthMode = 'setup' | 'login';

export interface LogEntry {
  type: string;
  message: string;
  timestamp: number;
}

export interface TerminalSession {
  id: string;
  type?: 'agent' | 'shell';
  cwd: string;
  name: string;
  createdAt: number;
  loading?: boolean;
}

// View state
export const view = signal<View>('loading');
export const activeSection = signal<Section>('home');
export const authMode = signal<AuthMode>('setup');

// Claude
export const claudeAuthenticated = signal(false);

// Account
export const accountEmail = signal<string | null>(null);
export const accountOrg = signal<string | null>(null);
export const accountUuid = signal<string | null>(null);

// Sessions
export const sessions = signal<TerminalSession[]>([]);
export const activeSessionId = signal<string | null>(null);

// Derived session state
export const activeSession = computed(() =>
  sessions.value.find(s => s.id === activeSessionId.value) ?? null
);
export const sessionCount = computed(() => sessions.value.length);

// Connection
export const wsConnected = signal(false);

// Logs
export const logs = signal<LogEntry[]>([]);
export const logsExpanded = signal(false);

// Preset
export const presetConfigured = signal(false);

// Workspace
export const workspacePath = signal('/workspace');

// Agent
export const agentName = signal('Claude');

// Ports
export interface PortInfo { port: number; exposed: boolean; }
export const activePorts = signal<PortInfo[]>([]);

// Docker experimental mode
export const dockerExperimental = signal(false);

// Files
export const currentFilesPath = signal('');

// ── Centralized setters ──
// All signal mutations should go through these functions to provide a single
// mutation point for logging, validation, or side effects.

export function setView(v: View): void { view.value = v; }
export function setActiveSection(s: Section): void { activeSection.value = s; }
export function setAuthMode(m: AuthMode): void { authMode.value = m; }
export function setActiveSessionId(id: string | null): void { activeSessionId.value = id; }
export function setWsConnected(v: boolean): void { wsConnected.value = v; }
export function setPresetConfigured(v: boolean): void { presetConfigured.value = v; }
export function setActivePorts(ports: PortInfo[]): void { activePorts.value = ports; }
export function setAccountInfo(email: string | null, org: string | null, uuid: string | null): void {
  accountEmail.value = email;
  accountOrg.value = org;
  accountUuid.value = uuid;
}

export function updateStateFromServer(data: Record<string, any>): void {
  if (data.claude) {
    claudeAuthenticated.value = data.claude.authenticated;
    if (data.claude.accountInfo) {
      setAccountInfo(
        data.claude.accountInfo.email,
        data.claude.accountInfo.organizationName,
        data.claude.accountInfo.accountUuid,
      );
    }
  }
  if (data.preset) {
    setPresetConfigured(data.preset.configured);
  }
  if (data.workspace) {
    workspacePath.value = data.workspace;
  }
  if (data.agent?.name) {
    agentName.value = data.agent.name;
  }
  if (data.git) {
    // Could expand git state signals if needed
  }
  if (typeof data.dockerExperimental === 'boolean') {
    dockerExperimental.value = data.dockerExperimental;
  }
  if (data.sessions) {
    setSessions(data.sessions.map((s: any) => ({
      id: s.id,
      type: s.type as 'agent' | 'shell',
      cwd: s.cwd,
      name: s.name,
      createdAt: s.createdAt || Date.now(),
    })));
  }
}

const MAX_LOGS = 1000;

export function addLog(entry: LogEntry): void {
  const newLogs = [...logs.value, entry];
  logs.value = newLogs.length > MAX_LOGS ? newLogs.slice(-MAX_LOGS) : newLogs;
}

export function addLocalLog(type: string, message: string): void {
  addLog({ type, message, timestamp: Date.now() });
}

export function clearLogs(): void {
  logs.value = [];
}

export function addSession(s: TerminalSession): void {
  // Deduplicate: skip if session with same ID already exists
  if (sessions.value.some(existing => existing.id === s.id)) return;
  sessions.value = [...sessions.value, s];
}

export function setSessions(list: TerminalSession[]): void {
  sessions.value = list;
  // If active session is gone, switch to first available
  if (activeSessionId.value && !list.find(s => s.id === activeSessionId.value)) {
    activeSessionId.value = list.length > 0 ? list[0].id : null;
  }
}

export function replaceSession(oldId: string, session: TerminalSession): void {
  sessions.value = sessions.value.map(s => s.id === oldId ? session : s);
}

export function renameSession(id: string, name: string): void {
  sessions.value = sessions.value.map(s => s.id === id ? { ...s, name } : s);
}

export function removeSession(id: string): void {
  sessions.value = sessions.value.filter(s => s.id !== id);
  if (activeSessionId.value === id) {
    const remaining = sessions.value;
    activeSessionId.value = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
  }
}

// ── Proactive Agents ──

export interface ProactiveAgent {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'error';
  schedule: string;
  objective: string;
  cwd: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  consecutiveFailures?: number;
  lastExecutionAt: number | null;
  lastResult: 'success' | 'failure' | 'timeout' | null;
  nextRunAt: number | null;
  totalExecutions: number;
  running: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export const proactiveAgents = signal<ProactiveAgent[]>([]);
export const agentOutputs = signal<Record<string, string>>({});

export function setProactiveAgents(list: ProactiveAgent[]): void {
  proactiveAgents.value = list;
}

export function updateProactiveAgent(agent: ProactiveAgent): void {
  const existing = proactiveAgents.value.find(a => a.id === agent.id);
  if (existing) {
    proactiveAgents.value = proactiveAgents.value.map(a => a.id === agent.id ? { ...a, ...agent } : a);
  } else {
    proactiveAgents.value = [...proactiveAgents.value, agent];
  }
}

export function removeProactiveAgent(id: string): void {
  proactiveAgents.value = proactiveAgents.value.filter(a => a.id !== id);
}

export function setAgentRunning(agentId: string, running: boolean): void {
  proactiveAgents.value = proactiveAgents.value.map(a =>
    a.id === agentId ? { ...a, running } : a
  );
}

const MAX_AGENT_OUTPUT = 512 * 1024; // 512KB per agent

export function appendAgentOutput(agentId: string, text: string): void {
  const current = agentOutputs.value[agentId] || '';
  const updated = current + text;
  agentOutputs.value = {
    ...agentOutputs.value,
    [agentId]: updated.length > MAX_AGENT_OUTPUT ? updated.slice(-MAX_AGENT_OUTPUT) : updated,
  };
}

export function clearAgentOutput(agentId: string): void {
  const copy = { ...agentOutputs.value };
  delete copy[agentId];
  agentOutputs.value = copy;
}
