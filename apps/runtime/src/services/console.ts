import { spawn as ptySpawn, type IPty } from 'node-pty';
import { readFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, renameSync, statSync } from 'fs';
import { readdir as readdirAsync, stat as statAsync, readFile as readFileAsync } from 'fs/promises';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { realpathSync } from 'fs';
import { execFileSync } from 'child_process';
import { ACTIVE_AGENT } from './agent.js';
import { syncToClaudeSettings } from './permissions.js';
import { startSessionCapture, captureInput, captureOutput, endSessionCapture } from './session-writer.js';
import { atomicWriteFileSync } from './memory.js';
import { summarizeSession } from './session-summarizer.js';
import { injectContextIntoCLAUDEMd } from './memory-context.js';
import {
  getValidAgentBinary, resolveAgentBinary, getOAuthEnv, ensureOnboardingComplete,
  buildCleanEnv, getAgentBinaryPath, setAgentBinaryPath,
} from './claude-env.js';

const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB max buffered output per session
export const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '5', 10);

interface ConsoleSession {
  id: string;
  type: 'agent' | 'shell';
  pty: IPty;
  cwd: string;
  name: string;
  createdAt: number;
  outputBuffer: string[];
  outputBufferSize: number;
  attached: boolean;
  conversationId?: string;
}

const sessions = new Map<string, ConsoleSession>();
// Set to true during destroyAllSessions() to suppress per-session state saves
// that would overwrite the shutdown snapshot with an empty session list.
let suppressStateSave = false;

console.log(`[Console] Agent binary resolved: ${getAgentBinaryPath()}`);

// Permissions are managed by services/permissions.ts
// Always syncs enabled permissions to ~/.claude/settings.json before spawn

interface CreateSessionOptions {
  cwd?: string;
  resume?: boolean;
  useContinue?: boolean;   // use --continue (resumes most recent conv for cwd, no picker)
  continuationPrompt?: string;
  conversationId?: string;
}

/**
 * Detect the conversation ID for a Claude session by polling the project dir.
 * - Fresh sessions: wait for a NEW .jsonl file to appear.
 * - Resume/continue sessions: wait for an EXISTING .jsonl file's mtime to change
 *   (Claude writes to it when the conversation is resumed).
 * Runs async (fire-and-forget) — does not block session creation.
 */
/**
 * Detect the conversation ID using fully async I/O.
 * Previous implementation used readdirSync/statSync/readFileSync inside a 500ms setInterval,
 * which blocked the Node.js event loop for seconds when project directories had many .jsonl files.
 * This caused the runtime to stop processing WS messages (including console:input) → input freeze.
 */
function detectConversationId(session: ConsoleSession, watchExisting = false): void {
  const encoded = encodeProjectPath(session.cwd);
  const projectDir = `${ACTIVE_AGENT.projectsDir}/${encoded}`;

  (async () => {
    // Snapshot existing .jsonl files (and their mtimes for resume detection)
    const existingFiles = new Set<string>();
    const existingMtimes = new Map<string, number>();
    try {
      const entries = await readdirAsync(projectDir).catch(() => [] as string[]);
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        existingFiles.add(f);
        if (watchExisting) {
          try {
            const s = await statAsync(`${projectDir}/${f}`);
            existingMtimes.set(f, s.mtimeMs);
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    // Poll (500ms intervals, up to 15s) — fully async to avoid blocking event loop
    let attempts = 0;
    const maxAttempts = 30;
    let polling = false;
    const interval = setInterval(async () => {
      if (polling) return; // Skip if previous async iteration still running
      polling = true;
      attempts++;
      try {
        const files = await readdirAsync(projectDir).catch(() => [] as string[]);
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

        let found: string | undefined;
        if (watchExisting) {
          // Resume mode: look for a file whose mtime has changed (Claude wrote to it)
          for (const f of jsonlFiles) {
            try {
              const s = await statAsync(`${projectDir}/${f}`);
              if (s.mtimeMs > (existingMtimes.get(f) ?? 0)) {
                found = f;
                break;
              }
            } catch { /* ignore */ }
          }
        } else {
          // Fresh session: look for a brand-new file
          found = jsonlFiles.find(f => !existingFiles.has(f));
        }

        if (found) {
          // Validate the file has real conversation messages (not just metadata like file-history-snapshot)
          if (!(await hasRealMessagesAsync(`${projectDir}/${found}`))) {
            // Not a real conversation yet — keep polling
            return;
          }
          session.conversationId = found.replace('.jsonl', '');
          saveSessionState('conversation_detected');
          console.log(`[Console] Detected conversation: ${session.conversationId} (${watchExisting ? 'resume' : 'new'})`);
          clearInterval(interval);
        } else if (attempts >= maxAttempts) {
          console.warn(`[Console] Could not detect conversation ID for session ${session.id}`);
          clearInterval(interval);
        }
      } catch {
        clearInterval(interval);
      } finally {
        polling = false;
      }
    }, 500);
  })();
}

export function createConsoleSession(options?: string | CreateSessionOptions): ConsoleSession {
  const id = randomUUID();

  // Support legacy string-only cwd argument
  const opts: CreateSessionOptions = typeof options === 'string' ? { cwd: options } : (options || {});
  const workDir = resolve(opts.cwd || process.env.WORKSPACE || '/workspace');

  // Validate cwd exists to prevent execvp failures
  if (!existsSync(workDir)) {
    throw new Error(`Working directory does not exist: ${workDir}`);
  }

  ensureOnboardingComplete();
  syncToClaudeSettings();

  const oauthEnv = getOAuthEnv();
  const finalEnv = { ...buildCleanEnv(), ...oauthEnv, TERM: 'xterm-256color' };

  // Build CLI args from launch options
  const args: string[] = [];
  if (opts.useContinue) {
    // Restore/auto-resume: --continue picks the most recent conversation for this cwd
    args.push(ACTIVE_AGENT.flags.continue);
  } else if (opts.resume) {
    if (opts.conversationId) {
      // Auto-restore: resume specific conversation (no picker, no prompt needed)
      args.push(ACTIVE_AGENT.flags.resume, opts.conversationId);
    } else if (opts.continuationPrompt) {
      // Legacy: --continue with prompt (resumes most recent)
      args.push(ACTIVE_AGENT.flags.continue, '-p', opts.continuationPrompt);
    } else {
      // User-initiated: use --resume (shows interactive picker)
      args.push(ACTIVE_AGENT.flags.resume);
    }
  }

  // Inject memory context into workspace CLAUDE.md before spawning
  try {
    injectContextIntoCLAUDEMd(workDir);
  } catch (e) {
    console.warn(`[Console] Memory context injection failed: ${(e as Error).message}`);
  }

  const binary = getValidAgentBinary();
  console.log(`[Console] Spawning claude PTY: binary=${binary}, cwd=${workDir}, args=[${args.join(', ')}], sessions=${sessions.size}, OAUTH_TOKEN=${oauthEnv.CLAUDE_CODE_OAUTH_TOKEN ? 'set' : 'NOT SET'}`);

  let pty: IPty;
  try {
    pty = ptySpawn(binary, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workDir,
      env: finalEnv,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Console] ptySpawn failed: ${msg} (binary=${binary}, cwd=${workDir})`);
    throw new Error(`Failed to spawn ${ACTIVE_AGENT.command}: ${msg}`);
  }

  const name = workDir.split('/').pop() || workDir;
  const session: ConsoleSession = { id, type: 'agent', pty, cwd: workDir, name, createdAt: Date.now(), outputBuffer: [], outputBufferSize: 0, attached: false };

  // Set or detect conversation ID for agent sessions
  if (opts.conversationId) {
    // Known ID (auto-restore): set directly
    session.conversationId = opts.conversationId;
  } else if (opts.useContinue || (opts.resume && !opts.conversationId)) {
    // --continue or interactive --resume: detect which existing conversation was touched
    detectConversationId(session, true);
  } else if (!opts.resume) {
    // Fresh session: detect the new .jsonl file that Claude creates
    detectConversationId(session, false);
  }

  // Start session capture for transcript logging
  startSessionCapture(id, workDir);

  // Buffer PTY output until a WS client attaches (with size cap)
  pty.onData((data: string) => {
    captureOutput(id, data);
    if (!session.attached) {
      session.outputBuffer.push(data);
      session.outputBufferSize += data.length;
      while (session.outputBufferSize > MAX_BUFFER_SIZE && session.outputBuffer.length > 0) {
        const dropped = session.outputBuffer.shift()!;
        session.outputBufferSize -= dropped.length;
      }
    }
  });

  sessions.set(id, session);
  saveSessionState('session_created');
  return session;
}

export function createShellSession(cwd?: string): ConsoleSession {
  const t0 = Date.now();
  const id = randomUUID();
  const workDir = resolve(cwd || process.env.WORKSPACE || '/workspace');

  if (!existsSync(workDir)) {
    throw new Error(`Working directory does not exist: ${workDir}`);
  }

  const finalEnv = { ...buildCleanEnv(), TERM: 'xterm-256color' };

  console.log(`[Console] Shell: step1 env built +${Date.now() - t0}ms`);

  let pty: IPty;
  try {
    pty = ptySpawn('/bin/bash', [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workDir,
      env: finalEnv,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Console] Shell ptySpawn failed: ${msg}`);
    throw new Error(`Failed to spawn shell: ${msg}`);
  }

  console.log(`[Console] Shell: step2 ptySpawn done +${Date.now() - t0}ms`);

  const name = 'Shell';
  const session: ConsoleSession = { id, type: 'shell', pty, cwd: workDir, name, createdAt: Date.now(), outputBuffer: [], outputBufferSize: 0, attached: false };

  startSessionCapture(id, workDir);
  console.log(`[Console] Shell: step3 capture started +${Date.now() - t0}ms`);

  pty.onData((data: string) => {
    captureOutput(id, data);
    if (!session.attached) {
      session.outputBuffer.push(data);
      session.outputBufferSize += data.length;
      while (session.outputBufferSize > MAX_BUFFER_SIZE && session.outputBuffer.length > 0) {
        const dropped = session.outputBuffer.shift()!;
        session.outputBufferSize -= dropped.length;
      }
    }
  });

  sessions.set(id, session);
  saveSessionState('session_created');
  console.log(`[Console] Shell: done +${Date.now() - t0}ms id=${id.slice(0,8)}`);
  return session;
}

export function getSession(id: string): ConsoleSession | undefined {
  return sessions.get(id);
}

export function getSessionCount(): number {
  return sessions.size;
}

export function resizeSession(id: string, cols: number, rows: number): void {
  sessions.get(id)?.pty.resize(cols, rows);
}

export function writeToSession(id: string, data: string): void {
  captureInput(id, data);
  const session = sessions.get(id);
  if (!session) {
    // Session not found — input discarded. If this appears in logs during a freeze,
    // the browser is sending console:input for a session that no longer exists
    // (e.g. PTY exited silently and browser state is stale).
    console.warn(`[Console] writeToSession: session ${id.slice(0,8)} NOT FOUND — input discarded (${data.length}B)`);
    return;
  }
  try {
    session.pty.write(data);
  } catch (e) {
    console.error(`[Console] pty.write FAILED for ${id.slice(0,8)}: ${(e as Error).message} — PTY may be dead`);
  }
}

export function destroySession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;

  endSessionCapture(id);
  const sessionCwd = session.cwd;
  sessions.delete(id);

  // Auto-summarize session transcript in background
  setImmediate(() => {
    summarizeSession(id, sessionCwd).catch(err =>
      console.warn(`[SessionSummarizer] Failed for ${id}: ${err.message}`)
    );
  });

  // Send SIGTERM first to allow graceful shutdown (flush buffers, close files)
  try {
    session.pty.kill('SIGTERM');
  } catch {
    // Process may have already exited
  }

  // Force SIGKILL after 2s grace period if still running
  setTimeout(() => {
    try {
      session.pty.kill('SIGKILL');
    } catch {
      // Process already exited — expected
    }
  }, 2000);

  if (!suppressStateSave) saveSessionState('session_destroyed');
}

export function destroyAllSessions(): void {
  suppressStateSave = true;
  for (const [id] of sessions) destroySession(id);
  suppressStateSave = false;
}

export function markSessionAttached(id: string): string[] {
  const session = sessions.get(id);
  if (!session) return [];
  session.attached = true;
  const buffered = session.outputBuffer;
  session.outputBuffer = [];
  session.outputBufferSize = 0;
  return buffered;
}

/**
 * Reset attachment state so PTY output is buffered again.
 * Called when all WS clients disconnect — ensures that output produced while
 * no client is connected is buffered and replayed on the next console:attach.
 */
export function resetSessionAttachment(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.attached = false;
}

export function renameSession(id: string, name: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.name = name;
  saveSessionState('session_renamed');
  return true;
}

export function listSessions(): Array<{ id: string; type: string; cwd: string; name: string; createdAt: number }> {
  return Array.from(sessions.values()).map(s => ({ id: s.id, type: s.type, cwd: s.cwd, name: s.name, createdAt: s.createdAt }));
}

/**
 * Encode a project path the same way Claude Code does for ~/.claude/projects/.
 * Replaces /, \, :, and spaces with '-'.
 * Uses realpathSync to dereference symlinks — Claude CLI also resolves symlinks,
 * so a cwd like /home/codeck/workspace/codeck (→ /opt/codeck) must encode as -opt-codeck.
 */
function encodeProjectPath(cwd: string): string {
  let absolute = resolve(cwd);
  try { absolute = realpathSync(absolute); } catch { /* path may not exist or resolve */ }
  return absolute.replace(/[/\\: ]/g, '-');
}

/**
 * Check if a .jsonl file contains at least one real conversation message (user or assistant type).
 * Filters out files that only contain metadata entries like file-history-snapshot.
 * Sync version — used only in startup paths (restoreSavedSessions).
 */
function hasRealMessages(filePath: string): boolean {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    return lines.some(line => {
      try {
        const d = JSON.parse(line);
        return d.type === 'user' || d.type === 'assistant';
      } catch { return false; }
    });
  } catch { return false; }
}

/**
 * Async version of hasRealMessages — used in polling paths to avoid blocking the event loop.
 * Reading large .jsonl conversation files synchronously was blocking for 100ms+ per file.
 */
async function hasRealMessagesAsync(filePath: string): Promise<boolean> {
  try {
    const content = await readFileAsync(filePath, 'utf8');
    return content.split('\n').some(line => {
      if (!line) return false;
      try {
        const d = JSON.parse(line);
        return d.type === 'user' || d.type === 'assistant';
      } catch { return false; }
    });
  } catch { return false; }
}

/**
 * Find the most recent valid conversation ID for the given cwd.
 * "Valid" means the .jsonl file has at least one real user/assistant message.
 * Returns undefined if no valid conversation is found.
 */
function findMostRecentConversation(cwd: string): string | undefined {
  const encoded = encodeProjectPath(cwd);
  const projectDir = `${ACTIVE_AGENT.projectsDir}/${encoded}`;
  try {
    if (!existsSync(projectDir)) return undefined;
    const files = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .flatMap(f => {
        try { return [{ name: f, mtime: statSync(`${projectDir}/${f}`).mtimeMs }]; }
        catch { return []; }
      })
      .sort((a, b) => b.mtime - a.mtime); // most recent first
    for (const { name } of files) {
      if (hasRealMessages(`${projectDir}/${name}`)) return name.replace('.jsonl', '');
    }
    return undefined;
  } catch { return undefined; }
}

/**
 * Check if a directory has previous Claude Code conversations that can be resumed.
 */
export async function hasResumableConversations(cwd: string): Promise<boolean> {
  const encoded = encodeProjectPath(cwd);
  const projectDir = `${ACTIVE_AGENT.projectsDir}/${encoded}`;
  try {
    const files = await readdirAsync(projectDir).catch(() => [] as string[]);
    return files.some(f => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

// ── Session Persistence ──

const SESSIONS_STATE_PATH = resolve(process.env.WORKSPACE || '/workspace', '.codeck/state/sessions.json');

interface SavedSession {
  id: string;
  type: 'agent' | 'shell';
  cwd: string;
  name: string;
  reason: string;
  conversationId?: string;
  continuationPrompt?: string;
}

interface SessionsState {
  version: number;
  savedAt: number;
  sessions: SavedSession[];
}

export function saveSessionState(reason: string, continuationPrompt?: string): SessionsState {
  const saved: SavedSession[] = [];
  for (const [, session] of sessions) {
    saved.push({
      id: session.id,
      type: session.type,
      cwd: session.cwd,
      name: session.name,
      reason,
      conversationId: session.type === 'agent' ? session.conversationId : undefined,
      continuationPrompt: session.type === 'agent' ? continuationPrompt : undefined,
    });
  }
  const state: SessionsState = { version: 1, savedAt: Date.now(), sessions: saved };

  // If there are no sessions to save, remove the file entirely instead of writing an empty
  // state. This prevents phantom restore cycles: an empty sessions.json would cause
  // hasSavedSessions()=true on next startup, leading to a restore with 0 sessions and a
  // stuck "Restoring sessions..." overlay.
  if (saved.length === 0) {
    try { unlinkSync(SESSIONS_STATE_PATH); } catch { /* already gone */ }
    console.log(`[Console] Removed sessions state (reason: ${reason}): no sessions to persist`);
    return state;
  }

  const dir = resolve(SESSIONS_STATE_PATH, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(SESSIONS_STATE_PATH, JSON.stringify(state, null, 2));

  const detail = saved.map(s => `${s.id.slice(0, 8)}(conv:${s.conversationId?.slice(0, 8) || 'none'})`).join(', ');
  console.log(`[Console] Saved ${saved.length} sessions (reason: ${reason}): ${detail || 'none'}`);
  return state;
}

export function hasSavedSessions(): boolean {
  return existsSync(SESSIONS_STATE_PATH);
}

// True only while a session restore from the previous lifecycle is genuinely in progress.
// Set at module load (if sessions.json exists) and cleared after restoreSavedSessions() runs.
// Unlike hasSavedSessions(), this flag is NOT affected by saveSessionState() calls during
// normal operation — prevents new WS clients from seeing pendingRestore:true after startup.
let _pendingRestore: boolean = existsSync(SESSIONS_STATE_PATH);

export function isPendingRestore(): boolean {
  return _pendingRestore;
}

export function clearPendingRestore(): void {
  _pendingRestore = false;
}

export function restoreSavedSessions(): Array<{ id: string; type: string; cwd: string; name: string }> {
  if (!existsSync(SESSIONS_STATE_PATH)) return [];

  let state: SessionsState;
  try {
    const raw = JSON.parse(readFileSync(SESSIONS_STATE_PATH, 'utf8'));
    // Migrate old format (no version field) to v1
    state = {
      version: raw.version || 1,
      savedAt: raw.savedAt || Date.now(),
      sessions: raw.sessions || [],
    };
  } catch (e) {
    console.log('[Console] Failed to parse sessions.json:', (e as Error).message);
    return [];
  }

  console.log(`[Console] Restoring ${state.sessions.length} saved sessions...`);
  const restored: Array<{ id: string; type: string; cwd: string; name: string }> = [];

  for (const saved of state.sessions) {
    console.log(`[Console] Restoring session ${saved.id.slice(0, 8)}: type=${saved.type}, cwd=${saved.cwd}, conversationId=${saved.conversationId?.slice(0, 8) || 'none'}`);
    try {
      // Validate saved cwd exists, fallback to /workspace
      const cwd = existsSync(saved.cwd) ? saved.cwd : '/workspace';
      if (saved.type === 'agent') {
        let session: ConsoleSession;
        if (saved.conversationId) {
          // Best case: we have the exact conversation ID — resume it directly
          session = createConsoleSession({ cwd, resume: true, conversationId: saved.conversationId });
        } else {
          // Fallback: find the most recent valid conversation (with real user/assistant messages)
          // and resume it by ID.  Avoids --continue which can fail with trust dialogs or if
          // it can't find the conversation via its own heuristics.
          const recentConvId = findMostRecentConversation(cwd);
          if (recentConvId) {
            console.log(`[Console] Found recent conversation ${recentConvId.slice(0, 8)} for ${saved.id.slice(0, 8)}, resuming`);
            session = createConsoleSession({ cwd, resume: true, conversationId: recentConvId });
          } else {
            console.log(`[Console] No valid conversations for ${saved.id.slice(0, 8)}, starting fresh`);
            session = createConsoleSession({ cwd });
          }
        }
        restored.push({ id: session.id, type: session.type, cwd: session.cwd, name: session.name });
      } else {
        const session = createShellSession(cwd);
        restored.push({ id: session.id, type: session.type, cwd: session.cwd, name: session.name });
      }
    } catch (e) {
      console.log(`[Console] Failed to restore session ${saved.id.slice(0, 8)}:`, (e as Error).message);
    }
  }

  // Rename sessions.json to .bak after restore (keep for debugging, but won't re-trigger on next restart)
  try {
    renameSync(SESSIONS_STATE_PATH, SESSIONS_STATE_PATH + '.bak');
  } catch {
    try { unlinkSync(SESSIONS_STATE_PATH); } catch { /* ignore */ }
  }

  console.log(`[Console] Restored ${restored.length}/${state.sessions.length} sessions`);
  return restored;
}

/**
 * Safely update the agent CLI binary and re-resolve the path.
 * Returns the new version string or throws on failure.
 */
export function updateAgentBinary(): { version: string; binaryPath: string } {
  const pkg = '@anthropic-ai/claude-code';

  // Run npm update
  console.log(`[Console] Updating ${pkg}...`);
  try {
    execFileSync('npm', ['install', '-g', `${pkg}@latest`], { encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Update failed: ${msg}`);
  }

  // Re-resolve binary path
  const oldPath = getAgentBinaryPath();
  const newPath = resolveAgentBinary();
  setAgentBinaryPath(newPath);
  console.log(`[Console] Binary re-resolved: ${oldPath} → ${newPath}`);

  // Validate the new binary works
  let version = 'unknown';
  try {
    version = execFileSync(newPath, [ACTIVE_AGENT.flags.version], {
      encoding: 'utf8', timeout: 10000, stdio: 'pipe',
    }).trim();
  } catch {
    console.warn('[Console] Could not get version after update');
  }

  console.log(`[Console] Update complete: ${version} at ${newPath}`);
  return { version, binaryPath: newPath };
}

export async function flushAllSessions(timeoutMs = 10000): Promise<void> {
  const agentSessions = Array.from(sessions.values()).filter(s => s.type === 'agent');
  if (agentSessions.length === 0) return;

  console.log(`[Console] Flushing ${agentSessions.length} agent sessions (timeout: ${timeoutMs}ms)`);
  for (const session of agentSessions) {
    session.pty.write('/compact\n');
  }
  await new Promise(r => setTimeout(r, timeoutMs));
}

