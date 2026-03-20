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

let catalogCache: { skills: SkillEntry[]; fetchedAt: number } | null = null;
const CATALOG_TTL = 3_600_000; // 1 hour

async function fetchCatalog(): Promise<SkillEntry[]> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL) {
    return catalogCache.skills;
  }

  try {
    const res = await fetch('https://skills.sh');
    const html = await res.text();

    // Extract RSC payload chunks
    const chunkPattern = /self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs;
    let match;
    while ((match = chunkPattern.exec(html)) !== null) {
      const chunk = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      const skillsMatch = chunk.match(/"initialSkills":(\[.*?\])(?:,"|\\})/);
      if (skillsMatch) {
        const skills: SkillEntry[] = JSON.parse(skillsMatch[1]);
        catalogCache = { skills, fetchedAt: Date.now() };
        return skills;
      }
    }
  } catch (err) {
    console.error('[Skills] Failed to fetch catalog:', (err as Error).message);
  }

  return catalogCache?.skills || [];
}

// GET /catalog — returns skill list, optionally filtered by ?q=search
router.get('/catalog', async (req, res) => {
  const query = ((req.query.q || '') as string).toLowerCase().trim();
  const skills = await fetchCatalog();

  if (query) {
    const filtered = skills.filter(s =>
      s.name.toLowerCase().includes(query) ||
      s.source.toLowerCase().includes(query)
    );
    res.json({ skills: filtered });
  } else {
    res.json({ skills });
  }
});

// POST /install — install a skill using npx skills add
router.post('/install', async (req, res) => {
  const { source, skillId } = req.body;
  if (!source || !skillId) {
    res.status(400).json({ error: 'source and skillId required' });
    return;
  }

  // Validate format: owner/repo and simple skillId
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(source)) {
    res.status(400).json({ error: 'Invalid source format' });
    return;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(skillId)) {
    res.status(400).json({ error: 'Invalid skillId format' });
    return;
  }

  try {
    const { stdout, stderr } = await execFileAsync('npx', [
      '-y', 'skills', 'add', `${source}/${skillId}`
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
