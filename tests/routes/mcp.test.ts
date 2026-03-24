/**
 * MCP API Tests — /api/mcp
 *
 * Tests: list MCP servers, add/remove/toggle servers.
 * Mocks fs/promises to avoid reading/writing real .claude.json.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// Hoist mock functions for fs/promises
const { mockReadFile, mockWriteFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

// Mock global fetch for search endpoint
const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

vi.stubGlobal('fetch', mockFetch);

import mcpRouter from '../../apps/runtime/src/routes/mcp.routes.js';

describe('MCP API', () => {
  let app: Express;

  const SAMPLE_CONFIG = {
    mcpServers: {
      'context7': {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        env: { CONTEXT7_API_KEY: 'abc123' },
        description: 'Context7 docs',
      },
      'eslint': {
        command: 'npx',
        args: ['-y', '@anthropic/eslint-mcp'],
      },
    },
    _disabledMcpServers: {
      'playwright': {
        command: 'npx',
        args: ['-y', '@anthropic/playwright-mcp'],
        description: 'Browser automation',
      },
    },
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/mcp', mcpRouter);

    vi.clearAllMocks();

    // Default: return valid config
    mockReadFile.mockResolvedValue(JSON.stringify(SAMPLE_CONFIG));
    mockWriteFile.mockResolvedValue(undefined);
  });

  // ── GET /api/mcp ──

  describe('GET /api/mcp', () => {
    it('should list all servers (active and disabled)', async () => {
      const res = await request(app).get('/api/mcp').expect(200);

      expect(res.body.servers).toHaveLength(3);

      const names = res.body.servers.map((s: { name: string }) => s.name);
      expect(names).toContain('context7');
      expect(names).toContain('eslint');
      expect(names).toContain('playwright');
    });

    it('should mark active servers as enabled', async () => {
      const res = await request(app).get('/api/mcp').expect(200);

      const context7 = res.body.servers.find((s: { name: string }) => s.name === 'context7');
      expect(context7.enabled).toBe(true);
      expect(context7.command).toBe('npx');
      expect(context7.args).toEqual(['-y', '@upstash/context7-mcp']);
    });

    it('should mark disabled servers as not enabled', async () => {
      const res = await request(app).get('/api/mcp').expect(200);

      const playwright = res.body.servers.find((s: { name: string }) => s.name === 'playwright');
      expect(playwright.enabled).toBe(false);
    });

    it('should return envKeys without exposing values', async () => {
      const res = await request(app).get('/api/mcp').expect(200);

      const context7 = res.body.servers.find((s: { name: string }) => s.name === 'context7');
      expect(context7.envKeys).toEqual(['CONTEXT7_API_KEY']);
      // Value should not be present
      expect(context7.env).toBeUndefined();
    });

    it('should return empty servers when config is empty', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({}));

      const res = await request(app).get('/api/mcp').expect(200);

      expect(res.body.servers).toEqual([]);
    });

    it('should return empty servers when config file is missing', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const res = await request(app).get('/api/mcp').expect(200);

      expect(res.body.servers).toEqual([]);
    });
  });

  // ── POST /api/mcp ──

  describe('POST /api/mcp', () => {
    it('should add a new MCP server with name and command', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .send({
          name: 'new-server',
          command: 'npx',
          args: ['-y', 'new-mcp-pkg'],
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledOnce();

      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.mcpServers['new-server']).toBeDefined();
      expect(writtenData.mcpServers['new-server'].command).toBe('npx');
      expect(writtenData.mcpServers['new-server'].args).toEqual(['-y', 'new-mcp-pkg']);
    });

    it('should add a server with env and description', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .send({
          name: 'supabase',
          command: 'npx',
          args: ['-y', '@supabase/mcp'],
          env: { SUPABASE_ACCESS_TOKEN: 'token123' },
          description: 'Supabase MCP server',
        })
        .expect(200);

      expect(res.body.success).toBe(true);

      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      const server = writtenData.mcpServers['supabase'];
      expect(server.env).toEqual({ SUPABASE_ACCESS_TOKEN: 'token123' });
      expect(server.description).toBe('Supabase MCP server');
    });

    it('should return 400 for missing name', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .send({ command: 'npx' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('name is required');
    });

    it('should return 400 for non-string name', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .send({ name: 123, command: 'npx' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('name is required');
    });

    it('should return 400 for missing command', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .send({ name: 'test-server' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('command is required');
    });

    it('should return 400 for non-string command', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .send({ name: 'test-server', command: 42 })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('command is required');
    });

    it('should update an existing server', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .send({
          name: 'context7',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp@latest'],
        })
        .expect(200);

      expect(res.body.success).toBe(true);

      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.mcpServers['context7'].args).toEqual(['-y', '@upstash/context7-mcp@latest']);
    });

    it('should move a previously disabled server to active when re-added', async () => {
      const res = await request(app)
        .post('/api/mcp')
        .send({
          name: 'playwright',
          command: 'npx',
          args: ['-y', '@anthropic/playwright-mcp@latest'],
        })
        .expect(200);

      expect(res.body.success).toBe(true);

      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      // Should be in active, not disabled
      expect(writtenData.mcpServers['playwright']).toBeDefined();
      expect(writtenData._disabledMcpServers?.['playwright']).toBeUndefined();
    });
  });

  // ── DELETE /api/mcp/:name ──

  describe('DELETE /api/mcp/:name', () => {
    it('should remove an active server', async () => {
      const res = await request(app)
        .delete('/api/mcp/eslint')
        .expect(200);

      expect(res.body.success).toBe(true);

      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.mcpServers['eslint']).toBeUndefined();
    });

    it('should remove a disabled server', async () => {
      const res = await request(app)
        .delete('/api/mcp/playwright')
        .expect(200);

      expect(res.body.success).toBe(true);

      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData._disabledMcpServers?.['playwright']).toBeUndefined();
    });

    it('should return 404 for nonexistent server', async () => {
      const res = await request(app)
        .delete('/api/mcp/nonexistent')
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });
  });

  // ── POST /api/mcp/:name/toggle ──

  describe('POST /api/mcp/:name/toggle', () => {
    it('should disable an active server', async () => {
      const res = await request(app)
        .post('/api/mcp/context7/toggle')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.enabled).toBe(false);

      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.mcpServers['context7']).toBeUndefined();
      expect(writtenData._disabledMcpServers['context7']).toBeDefined();
    });

    it('should enable a disabled server', async () => {
      const res = await request(app)
        .post('/api/mcp/playwright/toggle')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.enabled).toBe(true);

      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData.mcpServers['playwright']).toBeDefined();
      expect(writtenData._disabledMcpServers?.['playwright']).toBeUndefined();
    });

    it('should clean up empty _disabledMcpServers', async () => {
      // Config with only one disabled server
      mockReadFile.mockResolvedValue(JSON.stringify({
        mcpServers: { 'active': { command: 'npx' } },
        _disabledMcpServers: { 'lonely': { command: 'npx' } },
      }));

      const res = await request(app)
        .post('/api/mcp/lonely/toggle')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.enabled).toBe(true);

      const writtenData = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenData._disabledMcpServers).toBeUndefined();
    });

    it('should return 404 for nonexistent server', async () => {
      const res = await request(app)
        .post('/api/mcp/nonexistent/toggle')
        .expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });
  });

  // ── GET /api/mcp/search ──

  describe('GET /api/mcp/search', () => {
    it('should return empty servers for empty query', async () => {
      const res = await request(app)
        .get('/api/mcp/search')
        .expect(200);

      expect(res.body.servers).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return empty servers for whitespace-only query', async () => {
      const res = await request(app)
        .get('/api/mcp/search?q=   ')
        .expect(200);

      expect(res.body.servers).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should fetch and transform results from registry', async () => {
      const registryResponse = {
        servers: [
          {
            server: {
              name: 'ai.smithery/test-mcp-server',
              title: 'Test MCP Server',
              description: 'A test server',
              packages: [
                {
                  registryType: 'npm',
                  identifier: '@test/mcp-server',
                  runtimeHint: 'npx',
                  environmentVariables: [
                    { name: 'API_KEY', description: 'The API key', isRequired: true },
                  ],
                },
              ],
            },
          },
        ],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(registryResponse),
      });

      const res = await request(app)
        .get('/api/mcp/search?q=test')
        .expect(200);

      expect(res.body.servers).toHaveLength(1);
      const server = res.body.servers[0];
      expect(server.registryName).toBe('ai.smithery/test-mcp-server');
      expect(server.title).toBe('Test MCP Server');
      expect(server.description).toBe('A test server');
      expect(server.command).toBe('npx');
      expect(server.args).toEqual(['-y', '@test/mcp-server']);
      expect(server.envVars).toHaveLength(1);
      expect(server.envVars[0].name).toBe('API_KEY');
      expect(server.envVars[0].required).toBe(true);
      expect(server.installable).toBe(true);
      expect(server.runtime).toBe('npx');
    });

    it('should handle pypi/uvx runtime hint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          servers: [{
            server: {
              name: 'python-mcp',
              packages: [{
                registryType: 'pypi',
                identifier: 'python-mcp-pkg',
                runtimeHint: 'uvx',
              }],
            },
          }],
        }),
      });

      const res = await request(app)
        .get('/api/mcp/search?q=python')
        .expect(200);

      const server = res.body.servers[0];
      expect(server.command).toBe('uvx');
      expect(server.args).toEqual(['python-mcp-pkg']);
    });

    it('should handle docker/oci runtime hint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          servers: [{
            server: {
              name: 'docker-mcp',
              packages: [{
                registryType: 'oci',
                identifier: 'docker-mcp-img',
                runtimeHint: 'docker',
              }],
            },
          }],
        }),
      });

      const res = await request(app)
        .get('/api/mcp/search?q=docker')
        .expect(200);

      const server = res.body.servers[0];
      expect(server.command).toBe('docker');
      expect(server.args).toEqual(['run', '-i', '--rm', 'docker-mcp-img']);
    });

    it('should fallback to npx when package has identifier but no runtime hint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          servers: [{
            server: {
              name: 'generic-mcp',
              packages: [{
                identifier: 'generic-pkg',
              }],
            },
          }],
        }),
      });

      const res = await request(app)
        .get('/api/mcp/search?q=generic')
        .expect(200);

      const server = res.body.servers[0];
      expect(server.command).toBe('npx');
      expect(server.args).toEqual(['-y', 'generic-pkg']);
    });

    it('should mark servers without packages as not installable', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          servers: [{
            server: {
              name: 'remote-only',
              description: 'A remote server',
              remotes: [{ url: 'https://example.com' }],
            },
          }],
        }),
      });

      const res = await request(app)
        .get('/api/mcp/search?q=remote')
        .expect(200);

      const server = res.body.servers[0];
      expect(server.command).toBe('');
      expect(server.installable).toBe(false);
      expect(server.runtime).toBe('remote');
    });

    it('should sort installable servers before non-installable', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          servers: [
            {
              server: {
                name: 'remote-server',
                remotes: [{ url: 'https://example.com' }],
              },
            },
            {
              server: {
                name: 'local-server',
                packages: [{
                  registryType: 'npm',
                  identifier: '@local/pkg',
                  runtimeHint: 'npx',
                }],
              },
            },
          ],
        }),
      });

      const res = await request(app)
        .get('/api/mcp/search?q=server')
        .expect(200);

      expect(res.body.servers[0].installable).toBe(true);
      expect(res.body.servers[1].installable).toBe(false);
    });

    it('should return 502 when registry returns non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
      });

      const res = await request(app)
        .get('/api/mcp/search?q=registry-error-test')
        .expect(502);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Registry returned 503');
    });

    it('should return 500 when fetch throws', async () => {
      mockFetch.mockRejectedValue(new Error('Network timeout'));

      const res = await request(app)
        .get('/api/mcp/search?q=network-failure-test')
        .expect(500);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Network timeout');
    });

    it('should handle empty servers array from registry', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ servers: [] }),
      });

      const res = await request(app)
        .get('/api/mcp/search?q=nonexistent')
        .expect(200);

      expect(res.body.servers).toEqual([]);
    });

    it('should derive title from name when title is not provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          servers: [{
            server: {
              name: 'ai.smithery/faithk7-gmail-mcp',
              packages: [{ identifier: 'gmail-pkg', runtimeHint: 'npx' }],
            },
          }],
        }),
      });

      const res = await request(app)
        .get('/api/mcp/search?q=gmail')
        .expect(200);

      const server = res.body.servers[0];
      // "faithk7-gmail-mcp" → cleaned to "gmail-mcp"
      expect(server.title).toBe('gmail-mcp');
    });
  });
});
