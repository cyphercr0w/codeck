#!/usr/bin/env node

/**
 * Repo Map Generator — Lightweight structural overview of a codebase.
 *
 * Generates a file tree with exported function/class signatures.
 * No tree-sitter needed — uses regex extraction for TS/JS/Python.
 * Output capped at ~2K tokens for injection into session context.
 *
 * Called at session start or on-demand. Caches to .codeck/repo-map.cache.
 */

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, extname, relative } from 'path';

const MAX_OUTPUT_CHARS = 8000; // ~2K tokens
const MAX_FILES = 200; // Don't scan huge monorepos
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.codeck', '.claude', 'coverage', '.turbo', '.cache']);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java']);

/**
 * Recursively collect code files, respecting ignore list.
 */
function collectFiles(dir, base, files = [], depth = 0) {
  if (depth > 8 || files.length >= MAX_FILES) return files;
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.') && entry !== '.env') continue;
      if (IGNORE_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        collectFiles(full, base, files, depth + 1);
      } else if (CODE_EXTENSIONS.has(extname(entry).toLowerCase())) {
        files.push(relative(base, full));
      }
    }
  } catch { /* permission errors, etc */ }
  return files;
}

/**
 * Extract exported symbols from a file using regex (no tree-sitter).
 * Returns array of signature strings.
 */
function extractSignatures(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const sigs = [];
    const ext = extname(filePath).toLowerCase();

    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      // TypeScript/JavaScript exports
      const patterns = [
        /^export\s+(?:async\s+)?function\s+(\w+)\s*\([^)]*\)/gm,
        /^export\s+(?:default\s+)?class\s+(\w+)/gm,
        /^export\s+(?:const|let)\s+(\w+)\s*[=:]/gm,
        /^export\s+interface\s+(\w+)/gm,
        /^export\s+type\s+(\w+)/gm,
      ];
      for (const pat of patterns) {
        let m;
        while ((m = pat.exec(content)) !== null) {
          sigs.push(m[0].replace(/\{[\s\S]*$/, '').trim().slice(0, 120));
        }
      }
    } else if (ext === '.py') {
      // Python top-level defs
      const patterns = [
        /^(?:async\s+)?def\s+(\w+)\s*\([^)]*\)/gm,
        /^class\s+(\w+)/gm,
      ];
      for (const pat of patterns) {
        let m;
        while ((m = pat.exec(content)) !== null) {
          sigs.push(m[0].slice(0, 120));
        }
      }
    } else if (ext === '.go') {
      const patterns = [
        /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\([^)]*\)/gm,
        /^type\s+(\w+)\s+struct/gm,
        /^type\s+(\w+)\s+interface/gm,
      ];
      for (const pat of patterns) {
        let m;
        while ((m = pat.exec(content)) !== null) {
          sigs.push(m[0].slice(0, 120));
        }
      }
    } else if (ext === '.rs') {
      const patterns = [
        /^pub\s+(?:async\s+)?fn\s+(\w+)/gm,
        /^pub\s+struct\s+(\w+)/gm,
        /^pub\s+enum\s+(\w+)/gm,
        /^pub\s+trait\s+(\w+)/gm,
      ];
      for (const pat of patterns) {
        let m;
        while ((m = pat.exec(content)) !== null) {
          sigs.push(m[0].slice(0, 120));
        }
      }
    }

    return sigs.slice(0, 10); // Max 10 signatures per file
  } catch {
    return [];
  }
}

/**
 * Generate the repo map for a directory.
 */
function generateRepoMap(projectDir) {
  const files = collectFiles(projectDir, projectDir);
  if (files.length === 0) return null;

  // Group by directory
  const dirs = new Map();
  for (const f of files) {
    const parts = f.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(f);
  }

  // Build output
  const lines = [`# Repo Map (${files.length} files)\n`];
  let totalChars = lines[0].length;

  // Sort directories: shorter paths first
  const sortedDirs = [...dirs.keys()].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  for (const dir of sortedDirs) {
    if (totalChars > MAX_OUTPUT_CHARS) break;

    const dirFiles = dirs.get(dir);
    const dirLine = `\n${dir}/`;
    lines.push(dirLine);
    totalChars += dirLine.length;

    for (const f of dirFiles) {
      if (totalChars > MAX_OUTPUT_CHARS) break;

      const fullPath = join(projectDir, f);
      const sigs = extractSignatures(fullPath);
      const fileName = f.split('/').pop();

      if (sigs.length > 0) {
        const fileLine = `  ${fileName}: ${sigs.join(', ')}`;
        const trimmed = fileLine.slice(0, 200);
        lines.push(trimmed);
        totalChars += trimmed.length;
      } else {
        const fileLine = `  ${fileName}`;
        lines.push(fileLine);
        totalChars += fileLine.length;
      }
    }
  }

  return lines.join('\n');
}

// ── Main: generate for cwd or argument ──

const targetDir = process.argv[2] || process.cwd();
if (!existsSync(targetDir)) {
  console.error(`Directory not found: ${targetDir}`);
  process.exit(1);
}

const map = generateRepoMap(targetDir);
if (map) {
  // Cache it
  const cacheDir = join(targetDir, '.codeck');
  if (existsSync(cacheDir)) {
    writeFileSync(join(cacheDir, 'repo-map.cache'), map);
  }
  console.log(map);
} else {
  console.log('No code files found.');
}
