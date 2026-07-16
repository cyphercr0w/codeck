#!/usr/bin/env node
/**
 * Capability Doctor — environment preflight for autonomous runs.
 *
 * Probes the *external capabilities* an autonomous run depends on (gh auth, git
 * remote, docker daemon, runtimes, headless browser, network egress, disk) with
 * REAL execution — not `which`. A stale shim passes `which` but cannot execute;
 * an installed `gh` still fails every call if it is not authenticated. The point
 * is to learn what is actually usable BEFORE a long run, so the agent plans
 * around a missing capability (or uses its documented fallback) instead of
 * discovering it mid-run and burning its retry budget.
 *
 * This complements `ecc/mcp-health-check.js` (which covers MCP servers only).
 *
 * Modes (argv):
 *   --probe    Probe + cache to state, print nothing. SessionStart (async).
 *   --inject   Read fresh cache (or bounded sync re-probe) and emit a compact
 *              additionalContext block listing only NOT-ready capabilities.
 *              UserPromptSubmit; injects once per probe (i.e. once per session).
 *   --json     Probe and print the full report as JSON. On-demand CLI.
 *   (default)  Probe and print a human-readable report. On-demand CLI.
 *
 * Never blocks the session: probe/inject always exit 0. Only the CLI modes use a
 * non-zero exit (2) when a capability the caller asked about is unavailable.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import http from 'http';
import https from 'https';

const STATE_DIR = process.env.CODECK_STATE_DIR || '/workspace/.codeck/state';
const CACHE_PATH = join(STATE_DIR, 'capabilities.json');
const INJECT_FLAG = join(STATE_DIR, 'capabilities-injected.json');
const SELF_PATH = '/workspace/.codeck/scripts/capability-doctor.mjs';

const CACHE_TTL_MS = 5 * 60 * 1000;      // re-probe at most every 5 min
const PROBE_TIMEOUT_MS = 2500;           // per external-command probe
const NET_TIMEOUT_MS = 1500;             // per network host

const OK = 'ok';
const DEGRADED = 'degraded';
const UNAVAILABLE = 'unavailable';
const UNKNOWN = 'unknown';

// ── helpers ────────────────────────────────────────────────────────────────

/** Run a command with a hard timeout. Never throws; reports ENOENT as missing. */
function run(cmd, args = [], timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise(resolve => {
    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ ok: false, code: null, missing: err.code === 'ENOENT', stdout: '', stderr: err.message });
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ ok: false, code: null, missing: false, timedOut: true, stdout, stderr });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', d => { if (stdout.length < 4000) stdout += d.toString(); });
    child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      finish({ ok: false, code: null, missing: err.code === 'ENOENT', stdout, stderr: err.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      finish({ ok: code === 0, code, missing: false, stdout, stderr });
    });
  });
}

/** Lightweight reachability check — any HTTP response counts as reachable. */
function reachable(urlString, timeoutMs = NET_TIMEOUT_MS) {
  return new Promise(resolve => {
    let settled = false;
    const done = ok => { if (!settled) { settled = true; resolve(ok); } };
    let req;
    try {
      const url = new URL(urlString);
      const client = url.protocol === 'https:' ? https : http;
      req = client.request(url, { method: 'HEAD' }, res => { res.resume(); done(true); });
    } catch {
      done(false);
      return;
    }
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch { /* ignore */ } done(false); });
    req.on('error', () => done(false));
    req.end();
  });
}

function cap(id, status, detail, fallback) {
  return { id, status, detail, fallback };
}

// ── probes ─────────────────────────────────────────────────────────────────

async function probeGh() {
  const r = await run('gh', ['auth', 'status']);
  if (r.missing) {
    return cap('gh', UNAVAILABLE, 'GitHub CLI not installed',
      'Use git over HTTPS/SSH + the GitHub REST API via curl with $GITHUB_TOKEN/$GH_TOKEN; do not call `gh` subcommands.');
  }
  if (r.ok) return cap('gh', OK, 'authenticated', null);
  return cap('gh', DEGRADED, `installed but not authenticated (${(r.stderr || r.stdout || '').split('\n')[0].slice(0, 80)})`,
    'Authenticate with `gh auth login`, or fall back to the GitHub REST API via curl with $GITHUB_TOKEN. Do not rely on `gh` until authed.');
}

async function probeGitRemote() {
  const inside = await run('git', ['rev-parse', '--is-inside-work-tree']);
  if (inside.missing) return cap('git', UNAVAILABLE, 'git not installed', 'No VCS available; work on files directly and warn the user.');
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return cap('git-remote', UNKNOWN, 'not inside a git repository', null);
  }
  const remotes = await run('git', ['remote']);
  if (remotes.ok && remotes.stdout.trim()) {
    return cap('git-remote', OK, `remote(s): ${remotes.stdout.trim().split('\n').join(', ')} (push/pull auth not network-verified)`, null);
  }
  return cap('git-remote', DEGRADED, 'repository has no remote configured',
    'Commit locally; a remote + credentials must be configured (and verified) before any push.');
}

async function probeRuntime(id, cmd, args = ['--version']) {
  const r = await run(cmd, args);
  if (r.missing) return cap(id, UNAVAILABLE, `${cmd} not installed`, `Install ${cmd} or use an available runtime.`);
  if (r.ok) return cap(id, OK, (r.stdout || r.stderr).trim().split('\n')[0].slice(0, 40), null);
  return cap(id, DEGRADED, `${cmd} present but errored`, `Check the ${cmd} installation before relying on it.`);
}

async function probePython() {
  const r = await run('python3', ['--version']);
  if (r.ok) return cap('python', OK, (r.stdout || r.stderr).trim().slice(0, 40), null);
  // python3 missing or errored (e.g. the Windows Store stub) — try `python`.
  const alt = await run('python', ['--version']);
  if (alt.ok) return cap('python', OK, (alt.stdout || alt.stderr).trim().slice(0, 40), null);
  if (r.missing && alt.missing) return cap('python', UNAVAILABLE, 'python3/python not installed', 'Install Python or avoid Python-based steps.');
  return cap('python', DEGRADED, 'python present but errored', 'Check the Python install before relying on it.');
}

async function probeDocker() {
  const r = await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (r.missing) return cap('docker', UNAVAILABLE, 'docker CLI not installed', 'Cannot run containers; run services in-process instead.');
  if (r.ok) return cap('docker', OK, `daemon up (${r.stdout.trim().slice(0, 20)})`, null);
  return cap('docker', DEGRADED, 'docker CLI present but daemon unreachable',
    'The Docker daemon is down. Do not assume sibling containers or host.docker.internal; run services in-process or ask the user to start Docker.');
}

async function probeBrowser() {
  const r = await run('npx', ['--no-install', 'playwright', '--version']);
  if (r.ok) return cap('browser', OK, r.stdout.trim().slice(0, 40), null);
  // Fallback: detect an installed chromium cache without invoking npx.
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const cacheDir = home ? join(home, '.cache', 'ms-playwright') : '';
  if (cacheDir && existsSync(cacheDir)) return cap('browser', OK, 'ms-playwright cache present', null);
  return cap('browser', UNAVAILABLE, 'Playwright/headless browser not ready',
    'Run `browser_install` (or `npx playwright install chromium`) before browser automation / visual-verify, or skip the visual step.');
}

async function probeNetwork() {
  const hosts = ['https://api.anthropic.com', 'https://github.com'];
  const results = await Promise.all(hosts.map(h => reachable(h)));
  const reachedCount = results.filter(Boolean).length;
  if (reachedCount === hosts.length) return cap('network', OK, 'egress to key hosts confirmed', null);
  if (reachedCount > 0) return cap('network', DEGRADED, 'partial egress (some hosts unreachable)', 'Some external hosts are unreachable; retry or note the limitation before network-dependent steps.');
  return cap('network', UNAVAILABLE, 'no egress to github.com / api.anthropic.com',
    'Network egress appears down (DNS/connectivity). Do not clone, WebFetch, or install packages; work offline and surface this to the user.');
}

async function probeDisk() {
  const target = existsSync('/workspace') ? '/workspace' : '.';
  const r = await run('df', ['-Pk', target]);
  if (!r.ok || r.missing) return cap('disk', UNKNOWN, 'df unavailable', null);
  const line = r.stdout.trim().split('\n').at(-1) || '';
  const cols = line.split(/\s+/);
  const availKb = Number(cols[3]);
  if (!Number.isFinite(availKb)) return cap('disk', UNKNOWN, 'could not parse df output', null);
  const availGb = availKb / (1024 * 1024);
  if (availGb < 1) return cap('disk', DEGRADED, `only ${availGb.toFixed(2)} GB free on ${target}`, 'Low disk. Clean build artifacts / package caches before large installs or builds.');
  return cap('disk', OK, `${availGb.toFixed(1)} GB free`, null);
}

async function probeAll() {
  const caps = await Promise.all([
    probeGh(),
    probeGitRemote(),
    probeRuntime('node', 'node'),
    probeRuntime('pnpm', 'pnpm'),
    probePython(),
    probeDocker(),
    probeBrowser(),
    probeNetwork(),
    probeDisk(),
  ]);
  return { generatedAt: Date.now(), capabilities: caps.filter(Boolean) };
}

// ── cache ──────────────────────────────────────────────────────────────────

function readCache() {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const data = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
    if (!data || !Array.isArray(data.capabilities)) return null;
    return data;
  } catch { return null; }
}

function writeCache(report) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(report, null, 2));
  } catch { /* best effort — never block */ }
}

async function freshReport() {
  const cached = readCache();
  if (cached && Date.now() - cached.generatedAt < CACHE_TTL_MS) return cached;
  const report = await probeAll();
  writeCache(report);
  return report;
}

// ── rendering ──────────────────────────────────────────────────────────────

const NOT_READY = new Set([DEGRADED, UNAVAILABLE]);

function renderInjection(report) {
  const problems = report.capabilities.filter(c => NOT_READY.has(c.status));
  if (!problems.length) return null;
  const lines = problems.map(c => {
    const fb = c.fallback ? ` Fallback: ${c.fallback}` : '';
    return `- ${c.id}: ${c.status.toUpperCase()} — ${c.detail}.${fb}`;
  });
  return [
    '<environment-capabilities>',
    'Preflight — some capabilities are NOT ready. Plan around these (use the fallback) instead of discovering them mid-run; do not spend retries on a capability flagged unavailable:',
    ...lines,
    `Re-check anytime: \`node ${SELF_PATH} --json\``,
    '</environment-capabilities>',
  ].join('\n');
}

function renderHuman(report) {
  const rows = report.capabilities.map(c => {
    const mark = c.status === OK ? '✓' : c.status === UNKNOWN ? '·' : '✗';
    return `  ${mark} ${c.id.padEnd(12)} ${c.status.padEnd(12)} ${c.detail || ''}`;
  });
  return [
    'Capability Doctor',
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
    '',
    ...rows,
    '',
  ].join('\n');
}

// ── modes ──────────────────────────────────────────────────────────────────

async function main() {
  const mode = process.argv[2] || '';

  if (mode === '--probe') {
    const report = await probeAll();
    writeCache(report);
    process.exit(0);
  }

  if (mode === '--inject') {
    // Teammates skip — only the lead needs environment context.
    if (process.env.CLAUDE_CODE_TEAM_NAME) process.exit(0);
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    let sessionId = '';
    try { sessionId = String(JSON.parse(input).session_id || ''); } catch { /* no session id */ }

    const report = await freshReport();

    // Inject once per session. Gate on session_id when the hook provides it
    // (race-free against the async SessionStart probe re-caching); otherwise
    // fall back to once-per-fresh-probe.
    const gateKey = sessionId || `probe:${report.generatedAt}`;
    let flag = {};
    try { if (existsSync(INJECT_FLAG)) flag = JSON.parse(readFileSync(INJECT_FLAG, 'utf-8')); } catch { /* reset */ }
    if (flag.gateKey === gateKey) process.exit(0);

    const injection = renderInjection(report);
    try {
      if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(INJECT_FLAG, JSON.stringify({ gateKey, at: Date.now() }));
    } catch { /* best effort */ }

    if (!injection) process.exit(0); // everything ready — inject nothing (token-frugal)
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: injection },
    }));
    process.exit(0);
  }

  // CLI report modes.
  const report = await probeAll();
  writeCache(report);
  const anyBlocking = report.capabilities.some(c => c.status === UNAVAILABLE);
  if (mode === '--json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderHuman(report));
  }
  process.exit(anyBlocking ? 2 : 0);
}

main().catch(err => {
  // Never block a session on the doctor.
  process.stderr.write(`[capability-doctor] ${err && err.message}\n`);
  process.exit(0);
});
