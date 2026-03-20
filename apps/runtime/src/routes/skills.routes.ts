import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const router = Router();

interface SkillEntry {
  source: string;
  skillId: string;
  name: string;
  installs: number;
}

// Cache for the default catalog (top skills, no query)
let defaultCache: { skills: SkillEntry[]; fetchedAt: number } | null = null;
const DEFAULT_CACHE_TTL = 3_600_000; // 1 hour

// Cache for search queries (short TTL)
const searchCache = new Map<string, { skills: SkillEntry[]; fetchedAt: number }>();
const SEARCH_CACHE_TTL = 300_000; // 5 minutes

/** Parse the ANSI output of `skills find` into structured data */
function parseSkillsOutput(output: string): SkillEntry[] {
  const skills: SkillEntry[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    // Match: owner/repo@skill-name  NNK installs
    const match = line.replace(/\x1b\[[0-9;]*m/g, '').match(/^(\S+\/\S+)@(\S+)\s+.*?(\d+(?:\.\d+)?[KM]?)\s*installs?/);
    if (match) {
      const source = match[1];
      const skillId = match[2];
      const name = match[2];
      let installs = 0;
      const raw = match[3];
      if (raw.endsWith('K')) installs = Math.round(parseFloat(raw) * 1000);
      else if (raw.endsWith('M')) installs = Math.round(parseFloat(raw) * 1000000);
      else installs = parseInt(raw, 10);
      skills.push({ source, skillId, name, installs });
    }
  }

  return skills;
}

/** Fetch skills using `npx skills find` CLI — searches 89K+ skills */
async function searchSkills(query: string): Promise<SkillEntry[]> {
  // Check cache
  const cacheKey = query.toLowerCase().trim();
  if (!cacheKey && defaultCache && Date.now() - defaultCache.fetchedAt < DEFAULT_CACHE_TTL) {
    return defaultCache.skills;
  }
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SEARCH_CACHE_TTL) {
    return cached.skills;
  }

  try {
    const args = query ? ['find', query] : ['find', ''];
    const { stdout } = await execFileAsync('npx', ['-y', 'skills', ...args], {
      timeout: 15_000,
      env: { ...process.env, HOME: process.env.HOME || '/root', NO_COLOR: '1' },
    });

    const skills = parseSkillsOutput(stdout);

    if (!cacheKey) {
      defaultCache = { skills, fetchedAt: Date.now() };
    } else {
      searchCache.set(cacheKey, { skills, fetchedAt: Date.now() });
      // Evict old cache entries
      if (searchCache.size > 50) {
        const oldest = [...searchCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
        if (oldest) searchCache.delete(oldest[0]);
      }
    }

    return skills;
  } catch (err) {
    console.error('[Skills] Find failed:', (err as Error).message);
    // Return stale cache if available
    if (!cacheKey && defaultCache) return defaultCache.skills;
    return cached?.skills || [];
  }
}

// Also keep the HTML scraper as fallback for the default catalog
async function fetchCatalogFallback(): Promise<SkillEntry[]> {
  if (defaultCache && Date.now() - defaultCache.fetchedAt < DEFAULT_CACHE_TTL) {
    return defaultCache.skills;
  }
  try {
    const res = await fetch('https://skills.sh');
    const html = await res.text();
    const chunkPattern = /self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs;
    let match;
    while ((match = chunkPattern.exec(html)) !== null) {
      const chunk = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      const skillsMatch = chunk.match(/"initialSkills":(\[.*?\])(?:,"|\\})/);
      if (skillsMatch) {
        const skills: SkillEntry[] = JSON.parse(skillsMatch[1]);
        defaultCache = { skills, fetchedAt: Date.now() };
        return skills;
      }
    }
  } catch { /* ignore */ }
  return defaultCache?.skills || [];
}

// GET /catalog — search 89K+ skills via CLI, fallback to HTML scrape
router.get('/catalog', async (req, res) => {
  const query = ((req.query.q || '') as string).trim();

  let skills = await searchSkills(query);

  // Fallback to HTML scrape if CLI returns nothing
  if (skills.length === 0 && !query) {
    skills = await fetchCatalogFallback();
  }

  res.json({ skills, total: query ? skills.length : 89000 });
});

// POST /install — install a skill
router.post('/install', async (req, res) => {
  const { source, skillId } = req.body;
  if (!source || !skillId) {
    res.status(400).json({ error: 'source and skillId required' });
    return;
  }

  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(source)) {
    res.status(400).json({ error: 'Invalid source format' });
    return;
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(skillId)) {
    res.status(400).json({ error: 'Invalid skillId format' });
    return;
  }

  try {
    const { stdout, stderr } = await execFileAsync('npx', [
      '-y', 'skills', 'add', `${source}/${skillId}`, '--all',
    ], {
      timeout: 30_000,
      cwd: '/workspace',
      env: { ...process.env, HOME: process.env.HOME || '/root' },
    });
    res.json({ success: true, output: stdout + stderr });
  } catch (err: any) {
    const output = (err.stdout || '') + (err.stderr || '');
    res.status(500).json({ error: 'Installation failed', output });
  }
});

export default router;
