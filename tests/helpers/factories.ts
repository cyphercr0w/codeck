/**
 * Test data factories for creating mock objects
 */

/**
 * Create a mock console session
 */
export function createMockConsoleSession(overrides = {}) {
  return {
    id: Math.random().toString(36).substring(7),
    type: 'claude' as const,
    cwd: '/workspace',
    created: Date.now(),
    pid: Math.floor(Math.random() * 10000) + 1000,
    status: 'running' as const,
    name: 'Test Session',
    attached: false,
    outputBuffer: [],
    ...overrides,
  };
}

/**
 * Create mock git status
 */
export function createMockGitStatus(overrides = {}) {
  return {
    isRepo: true,
    branch: 'main',
    hasRemote: true,
    remoteName: 'origin',
    remoteUrl: 'https://github.com/user/repo.git',
    hasChanges: false,
    ...overrides,
  };
}

/**
 * Create mock resource usage
 */
export function createMockResourceUsage(overrides = {}) {
  return {
    cpu: {
      usage: 25.5,
      cores: 4,
    },
    memory: {
      used: 512 * 1024 * 1024,
      total: 2048 * 1024 * 1024,
      percentage: 25,
    },
    disk: {
      used: 10 * 1024 * 1024 * 1024,
      total: 50 * 1024 * 1024 * 1024,
      percentage: 20,
    },
    ...overrides,
  };
}

/**
 * Create mock preset manifest
 */
export function createMockPreset(overrides = {}) {
  return {
    id: 'test-preset',
    name: 'Test Preset',
    description: 'A test preset',
    version: '1.0.0',
    files: [],
    ...overrides,
  };
}
