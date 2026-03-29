#!/usr/bin/env node
/**
 * Visual Brainstorming Helper
 *
 * Usage: node visual-brainstorm.mjs <title> < htmlContent
 * Or:    echo '<h1>Design A</h1>' | node visual-brainstorm.mjs "Option A"
 *
 * Writes HTML to a temp file served by a simple HTTP server,
 * then opens it in the preview panel.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { createServer } from 'http';
import { execFileSync } from 'child_process';

const BRAINSTORM_DIR = '/workspace/.codeck/state/brainstorm';
const PORT = 5199;

// Read HTML from stdin
let html = '';
for await (const chunk of process.stdin) html += chunk;

const title = process.argv[2] || 'Brainstorm';

if (!html.trim()) {
  console.error('Usage: echo "<html>" | node visual-brainstorm.mjs "Title"');
  process.exit(1);
}

// Wrap in full HTML document if not already
if (!html.includes('<html') && !html.includes('<!DOCTYPE')) {
  html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #0a0a0b; color: #fafafa; padding: 24px; }
  </style>
</head>
<body>
${html}
</body>
</html>`;
}

// Write to file
if (!existsSync(BRAINSTORM_DIR)) mkdirSync(BRAINSTORM_DIR, { recursive: true });
const fileName = `${Date.now()}-${title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.html`;
const filePath = join(BRAINSTORM_DIR, fileName);
writeFileSync(filePath, html);

// Start a simple HTTP server if not already running
try {
  execFileSync('curl', ['-sf', `http://localhost:${PORT}/`], { timeout: 1000 });
  // already running — nothing to do
} catch {
  const server = createServer((req, res) => {
    let target = filePath;
    if (req.url && req.url !== '/') {
      const requested = join(BRAINSTORM_DIR, basename(req.url));
      if (existsSync(requested)) target = requested;
    }
    try {
      const content = readFileSync(target, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  server.listen(PORT, '0.0.0.0');
  // Detach — don't block the caller
  server.unref();
}

// Open in preview panel
try {
  execFileSync('curl', [
    '-sf', '-X', 'POST',
    'http://localhost/api/preview/navigate-to',
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify({ port: PORT }),
  ], { timeout: 2000 });
  console.log(`Brainstorm "${title}" → preview panel (port ${PORT})`);
} catch {
  console.log(`Brainstorm "${title}" → saved to ${filePath}`);
}
