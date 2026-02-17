/**
 * Test helpers for file system operations
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Create a temporary test directory
 */
export function createTempDir(prefix = 'codeck-test-'): string {
  const tempPath = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).substring(7)}`);
  mkdirSync(tempPath, { recursive: true });
  return tempPath;
}

/**
 * Cleanup temporary directory
 */
export function cleanupTempDir(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Create a temporary file with content
 */
export function createTempFile(dir: string, filename: string, content: string): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Read a file from temp directory
 */
export function readTempFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

/**
 * Create a nested directory structure for testing
 */
export function createNestedDirs(baseDir: string, structure: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(structure)) {
    const fullPath = join(baseDir, path);
    if (content === null) {
      // It's a directory
      mkdirSync(fullPath, { recursive: true });
    } else {
      // It's a file
      const dir = join(fullPath, '..');
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    }
  }
}

/**
 * Create a test workspace with typical codeck structure
 */
export function createTestWorkspace(baseDir: string): string {
  const workspaceDir = join(baseDir, 'workspace');
  const codeck = join(workspaceDir, '.codeck');

  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(join(codeck, 'memory'), { recursive: true });
  mkdirSync(join(codeck, 'memory', 'daily'), { recursive: true });
  mkdirSync(join(codeck, 'memory', 'decisions'), { recursive: true });
  mkdirSync(join(codeck, 'sessions'), { recursive: true });
  mkdirSync(join(codeck, 'state'), { recursive: true });

  return workspaceDir;
}

/**
 * Mock file system for testing (using temporary directories)
 */
export class MockFileSystem {
  private tempDir: string;

  constructor() {
    this.tempDir = createTempDir('codeck-mock-fs-');
  }

  getPath(relativePath: string): string {
    return join(this.tempDir, relativePath);
  }

  writeFile(relativePath: string, content: string): void {
    const fullPath = this.getPath(relativePath);
    const dir = join(fullPath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  }

  readFile(relativePath: string): string {
    return readFileSync(this.getPath(relativePath), 'utf-8');
  }

  exists(relativePath: string): boolean {
    return existsSync(this.getPath(relativePath));
  }

  cleanup(): void {
    cleanupTempDir(this.tempDir);
  }
}
