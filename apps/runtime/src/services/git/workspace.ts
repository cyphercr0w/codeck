/**
 * Workspace CLAUDE.md management: project listing, template rendering.
 */
import { existsSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { ACTIVE_AGENT } from '../agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const WORKSPACE = resolve(process.env.WORKSPACE || '/workspace');

export function getWorkspacePath(): string { return WORKSPACE; }

// ── Inline repo listing (avoids circular dependency with operations.ts) ──
interface RepoEntry { name: string; path: string; }

function listRepos(): RepoEntry[] {
  const repos: RepoEntry[] = [];
  if (existsSync(`${WORKSPACE}/.git`)) {
    repos.push({ name: '.', path: WORKSPACE });
  }
  try {
    const dirs = readdirSync(WORKSPACE);
    for (const dir of dirs) {
      if (dir.startsWith('.') || dir.includes(':') || dir.includes('\\')) continue;
      if (existsSync(`${WORKSPACE}/${dir}/.git`)) {
        repos.push({ name: dir, path: `${WORKSPACE}/${dir}` });
      }
    }
  } catch { /* ignore */ }
  return repos;
}

/**
 * Generates/updates /workspace/${ACTIVE_AGENT.instructionFile} (Layer 2) with the project listing.
 * This is the ONLY instruction file this function manages.
 * Layer 1 is managed by the preset system.
 */
export function updateClaudeMd(): boolean {

  try {
    const repos = listRepos();
    const claudeMdPath = `${WORKSPACE}/${ACTIVE_AGENT.instructionFile}`;

    // Generate project list — sanitize names to prevent instruction injection
    let projectsList: string;
    if (repos.length === 0) {
      projectsList = '_No projects cloned yet_';
    } else {
      projectsList = repos.map(r => {
        const safeName = r.name.replace(/[^a-zA-Z0-9_\-. ]/g, '').slice(0, 100);
        return `- **${safeName}/** - \`${r.path}\``;
      }).join('\n');
    }

    // If CLAUDE.md already exists, try to update the projects marker in-place
    if (existsSync(claudeMdPath)) {
      const existing = readFileSync(claudeMdPath, 'utf-8');
      const presetMarker = /<!-- PROJECTS_LIST[^>]*-->[^]*$/;

      if (presetMarker.test(existing)) {
        const updated = existing.replace(
          presetMarker,
          `<!-- PROJECTS_LIST (auto-generated, do not edit manually) -->\n${projectsList}`
        );
        writeFileSync(claudeMdPath, updated);
        console.log(`[Workspace] ${ACTIVE_AGENT.instructionFile} project list updated`);
        return true;
      }

      // Legacy marker
      if (existing.includes('{{PROJECTS_LIST}}')) {
        writeFileSync(claudeMdPath, existing.replace('{{PROJECTS_LIST}}', projectsList));
        console.log(`[Workspace] ${ACTIVE_AGENT.instructionFile} updated (legacy marker)`);
        return true;
      }
    }

    // No instruction file exists — use the template from src/templates/CLAUDE.md
    // __dirname is services/git/, template is at ../../templates/CLAUDE.md
    const templatePath = join(__dirname, '../../templates/CLAUDE.md');
    let content: string;

    if (existsSync(templatePath)) {
      content = readFileSync(templatePath, 'utf-8');
      // Replace the default project list with actual projects
      const marker = /<!-- PROJECTS_LIST[^>]*-->[^]*$/;
      if (marker.test(content)) {
        content = content.replace(
          marker,
          `<!-- PROJECTS_LIST (auto-generated, do not edit manually) -->\n${projectsList}`
        );
      }
      console.log(`[Workspace] ${ACTIVE_AGENT.instructionFile} created from template`);
    } else {
      content = `# Workspace Projects\n\n<!-- PROJECTS_LIST (auto-generated, do not edit manually) -->\n${projectsList}\n`;
      console.log(`[Workspace] ${ACTIVE_AGENT.instructionFile} created (fallback — template not found)`);
    }

    writeFileSync(claudeMdPath, content);
    return true;
  } catch (err) {
    console.error(`[Workspace] Error updating ${ACTIVE_AGENT.instructionFile}:`, (err as Error).message);
    return false;
  }
}
