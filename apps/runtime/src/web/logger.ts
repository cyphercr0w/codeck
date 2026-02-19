import { WebSocket } from 'ws';
import { sanitizeSecrets } from '../services/session-writer.js';

export interface LogEntry {
  type: string;
  message: string;
  timestamp: number;
}

const MAX_LOGS = 100;
const MAX_ENTRY_LENGTH = 10240; // 10KB per entry
const logBuffer: LogEntry[] = [];
let wsClients: WebSocket[] = [];

// Strip absolute file paths from log messages to prevent leaking directory structure (CWE-209)
function sanitizeStackPaths(msg: string): string {
  // Replace absolute paths like /workspace/Codeck/src/services/console.ts:85:12
  return msg.replace(/\/([\w.-]+\/){2,}[\w.-]+(:\d+){0,2}/g, '[internal]');
}

export function addLog(type: string, message: string): void {
  const raw = sanitizeSecrets(typeof message === 'string' ? message : JSON.stringify(message));
  const sanitized = sanitizeStackPaths(raw);
  const truncated = sanitized.length > MAX_ENTRY_LENGTH
    ? sanitized.slice(0, MAX_ENTRY_LENGTH) + '... [truncated]'
    : sanitized;
  const entry: LogEntry = {
    type,
    message: truncated,
    timestamp: Date.now(),
  };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  broadcast({ type: 'log', data: entry });
}

export function getLogBuffer(): LogEntry[] {
  return logBuffer;
}

export function setWsClients(clients: WebSocket[]): void {
  wsClients = clients;
}

export function broadcast(data: unknown): void {
  const msg = JSON.stringify(data);
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// Intercept console.log/error/warn/info
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

export function installLogInterceptor(): void {
  console.log = (...args: unknown[]) => {
    originalLog.apply(console, args);
    addLog('info', args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
  };
  console.error = (...args: unknown[]) => {
    originalError.apply(console, args);
    addLog('error', args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    originalWarn.apply(console, args);
    addLog('warn', args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
  };
  console.info = (...args: unknown[]) => {
    originalInfo.apply(console, args);
    addLog('info', args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
  };
}
