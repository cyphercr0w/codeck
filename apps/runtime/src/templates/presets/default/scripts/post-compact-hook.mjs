#!/usr/bin/env node

/**
 * PostCompact Hook — Re-inject context after compaction.
 *
 * Project-aware: only injects memory relevant to the current working directory.
 * Does NOT dump global memory about unrelated projects.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

function computePathId(absPath) {
  return createHash('sha256').update(absPath).digest('hex').slice(0, 12);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const cwd = parsed.cwd || process.env.WORKSPACE || '/workspace';
const projectName = cwd.split('/').pop() || 'workspace';
const isProjectDir = cwd !== '/workspace' && cwd !== '/workspace/';
const sections = [];

// 1. Pre-compact state (what we were doing)
const preCompactPath = '/workspace/.codeck/state/pre-compact-state.json';
if (existsSync(preCompactPath)) {
  try {
    const state = JSON.parse(readFileSync(preCompactPath, 'utf-8'));
    const parts = [];
    parts.push(`Compacted at: ${state.timestamp}`);
    parts.push(`Project: ${state.projectName} (${state.cwd})`);
    if (state.modifiedFiles?.length) parts.push(`Modified files: ${state.modifiedFiles.join(', ')}`);
    if (state.activeAgents?.length) parts.push(`Active agents: ${state.activeAgents.map(a => a.name).join(', ')}`);
    sections.push(`<pre-compact-state>\n${parts.join('\n')}\n</pre-compact-state>`);

    // Inject daily log from pre-compact — but only entries related to current project
    if (state.dailyLog) {
      const filtered = filterDailyLogByProject(state.dailyLog, projectName);
      if (filtered) {
        sections.push(`<today-activity>\n${filtered}\n</today-activity>`);
      }
    }
  } catch { /* non-fatal */ }
}

// 2. Project-specific memory (PRIORITY — this is what matters)
if (isProjectDir) {
  const pathId = computePathId(cwd);
  const pathMemory = join('/workspace/.codeck/memory/paths', pathId, 'MEMORY.md');
  if (existsSync(pathMemory)) {
    const content = readFileSync(pathMemory, 'utf-8');
    sections.push(`<project-memory project="${projectName}">\n${content.slice(0, 3000)}\n</project-memory>`);
  }

  // Project-specific daily log
  const today = new Date().toISOString().slice(0, 10);
  const pathDailyPath = join('/workspace/.codeck/memory/paths', pathId, 'daily', `${today}.md`);
  if (existsSync(pathDailyPath)) {
    const pathDaily = readFileSync(pathDailyPath, 'utf-8').slice(-2000);
    sections.push(`<project-today project="${projectName}">\n${pathDaily}\n</project-today>`);
  }
}

// 3. Global memory — ONLY essential sections (not full dump of all projects)
const memoryPath = '/workspace/.codeck/memory/MEMORY.md';
if (existsSync(memoryPath)) {
  const full = readFileSync(memoryPath, 'utf-8');
  const filtered = filterGlobalMemory(full, projectName);
  if (filtered) {
    sections.push(`<durable-memory>\n${filtered}\n</durable-memory>`);
  }
}

// 4. User preferences (always relevant)
const prefsPath = '/workspace/.codeck/preferences.md';
if (existsSync(prefsPath)) {
  const prefs = readFileSync(prefsPath, 'utf-8').slice(0, 1000);
  sections.push(`<user-preferences>\n${prefs}\n</user-preferences>`);
}

// 5. Today's daily log (fallback if pre-compact didn't capture it)
if (!sections.some(s => s.includes('<today-activity>'))) {
  const today = new Date().toISOString().slice(0, 10);
  const dailyPath = join('/workspace/.codeck/memory/daily', `${today}.md`);
  if (existsSync(dailyPath)) {
    const daily = readFileSync(dailyPath, 'utf-8');
    const filtered = filterDailyLogByProject(daily, projectName);
    if (filtered) {
      sections.push(`<today-activity date="${today}">\n${filtered}\n</today-activity>`);
    }
  }
}

if (sections.length === 0) process.exit(0);

const reminder = [
  `<context-restored project="${projectName}">`,
  ...sections,
  '</context-restored>',
  '',
  `CONTEXT RESTORED for project "${projectName}". Only project-relevant memory was injected.`,
  'If you need info about other projects, read their path memory directly.',
].join('\n');

console.log(JSON.stringify({
  systemMessage: reminder,
}));

// ── Helpers ──

/** Filter global MEMORY.md to only include sections relevant to the current project */
function filterGlobalMemory(content, project) {
  const lines = content.split('\n');
  const result = [];
  let inRelevantSection = false;
  let sectionDepth = 0;

  // Always include: Environment, User Preferences, Security, Dinámica de Trabajo
  // Skip: Proyectos Activos details about OTHER projects, project-specific sections
  const alwaysInclude = ['environment', 'user preferences', 'security', 'capacidades', 'autonomía', 'identidad', 'contexto'];
  const skipProjects = ['bet-plan', 'tierras-sagradas', 'travel-notify']; // other projects

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,3})\s+(.*)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const title = headerMatch[2].toLowerCase();

      // Check if this section is about a different project
      const isOtherProject = skipProjects.some(p => title.includes(p)) && !title.includes(project.toLowerCase());
      const isAlwaysInclude = alwaysInclude.some(k => title.includes(k));

      if (isOtherProject) {
        inRelevantSection = false;
        sectionDepth = level;
        continue;
      }

      if (isAlwaysInclude || title.includes(project.toLowerCase())) {
        inRelevantSection = true;
      } else if (level <= sectionDepth) {
        inRelevantSection = true; // new top-level section, include by default
      }
    }

    if (inRelevantSection || !lines.some(l => l.startsWith('#'))) {
      result.push(line);
    }
  }

  const filtered = result.join('\n').trim();
  return filtered.length > 50 ? filtered.slice(0, 2000) : null;
}

/** Filter daily log to only include entries mentioning the current project */
function filterDailyLogByProject(content, project) {
  // If the daily log mentions the project, include the whole thing (it's today's work)
  // If it doesn't mention the project at all, include just the header + last 500 chars
  const lower = content.toLowerCase();
  const projLower = project.toLowerCase();

  if (lower.includes(projLower) || lower.includes(projLower.replace(/-/g, ' '))) {
    return content.slice(0, 3000);
  }

  // No mention of current project — include just a brief summary
  const lines = content.split('\n');
  const header = lines[0] || '';
  return `${header}\n(Daily log does not reference ${project} — read full log at /workspace/.codeck/memory/daily/ if needed)`;
}
