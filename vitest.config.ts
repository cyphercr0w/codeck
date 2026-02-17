import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // Test environment
    environment: 'node',

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',

      // Coverage thresholds (progressive)
      thresholds: {
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
      },

      // Include source files
      include: ['src/**/*.ts'],

      // Exclude files
      exclude: [
        'src/web/src/**', // Frontend (separate testing strategy)
        'src/web/vite.config.ts',
        'dist/**',
        'node_modules/**',
        'tests/**',
        '**/*.d.ts',
        '**/*.config.ts',
        '**/index.ts',
      ],
    },

    // Global test settings
    globals: true,
    isolate: true,

    // Timeouts
    testTimeout: 10000,
    hookTimeout: 10000,

    // Include/exclude patterns
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
    exclude: ['node_modules/**', 'dist/**'],

    // Setup files (run before each test file)
    // Redirects CODECK_DIR and CLAUDE_CONFIG_DIR to /tmp so tests
    // never touch the live server's auth files.
    setupFiles: ['./tests/setup.ts'],

    // Reporters
    reporters: ['verbose'],

    // Disable threads for easier debugging
    threads: false,

    // Mock reset behavior
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
  },

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@services': path.resolve(__dirname, './src/services'),
      '@routes': path.resolve(__dirname, './src/routes'),
      '@web': path.resolve(__dirname, './src/web'),
    },
  },
});
