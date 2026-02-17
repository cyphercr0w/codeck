/**
 * Smoke tests - verify basic functionality
 */
import { describe, it, expect } from 'vitest';

describe('Smoke Tests', () => {
  it('should pass basic assertion', () => {
    expect(1 + 1).toBe(2);
  });

  it('should have Node.js runtime', () => {
    expect(process.version).toBeDefined();
    expect(process.version).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it('should support ES modules', async () => {
    const module = await import('../src/services/auth.js');
    expect(module).toBeDefined();
  });

  it('should support async/await', async () => {
    const result = await Promise.resolve(42);
    expect(result).toBe(42);
  });
});
