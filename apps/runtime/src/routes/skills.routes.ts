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

// Cache for search queries
const searchCache = new Map<string, { skills: SkillEntry[]; fetchedAt: number }>();
const SEARCH_CACHE_TTL = 300_000; // 5 minutes

/** Parse the ANSI output of `skills find` into structured data */
function parseSkillsOutput(output: string): SkillEntry[] {
  const skills: SkillEntry[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
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

/** Search skills using `npx skills find` CLI — requires a non-empty query */
async function searchSkills(query: string): Promise<SkillEntry[]> {
  if (!query) return [];

  const cacheKey = query.toLowerCase().trim();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SEARCH_CACHE_TTL) {
    return cached.skills;
  }

  try {
    const { stdout } = await execFileAsync('npx', ['-y', 'skills', 'find', query], {
      timeout: 15_000,
      env: { ...process.env, HOME: process.env.HOME || '/root' },
    });

    const skills = parseSkillsOutput(stdout);
    searchCache.set(cacheKey, { skills, fetchedAt: Date.now() });

    // Evict old cache entries
    if (searchCache.size > 50) {
      const oldest = [...searchCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
      if (oldest) searchCache.delete(oldest[0]);
    }

    return skills;
  } catch (err) {
    console.error('[Skills] Find failed:', (err as Error).message);
    return cached?.skills || [];
  }
}

// GET /catalog — search skills via CLI (requires ?q= param)
router.get('/catalog', async (req, res) => {
  const query = ((req.query.q || '') as string).trim();
  const skills = await searchSkills(query);
  res.json({ skills });
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
