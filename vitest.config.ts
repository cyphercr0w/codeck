import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
	test: {
		// Test environment
		environment: "node",

		// Coverage configuration
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html", "lcov"],
			reportsDirectory: "./coverage",

			// Coverage thresholds (progressive)
			thresholds: {
				lines: 60,
				functions: 60,
				branches: 50,
				statements: 60,
			},

			// Include source files
			include: ["apps/runtime/src/**/*.ts"],

			// Exclude files
			exclude: [
				"apps/runtime/src/web/src/**", // Frontend (separate testing strategy)
				"apps/runtime/src/web/vite.config.ts",
				"dist/**",
				"node_modules/**",
				"tests/**",
				"**/*.d.ts",
				"**/*.config.ts",
				"**/index.ts",
			],
		},

		// Global test settings
		globals: true,
		isolate: true,

		// Timeouts
		testTimeout: 10000,
		hookTimeout: 10000,

		// Include/exclude patterns
		include: ["tests/**/*.test.ts", "tests/**/*.spec.ts"],
		exclude: ["node_modules/**", "dist/**"],

		// Setup files (run before each test file)
		// Redirects CODECK_DIR and CLAUDE_CONFIG_DIR to /tmp so tests
		// never touch the live server's auth files.
		setupFiles: ["./tests/setup.ts"],

		// Reporters
		reporters: ["verbose"],

		// Run test files sequentially — auth tests share module-level state
		// that leaks between files when running in parallel
		fileParallelism: false,

		// Mock reset behavior
		clearMocks: true,
		mockReset: true,
		restoreMocks: true,
	},

	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./apps/runtime/src"),
			"@services": path.resolve(__dirname, "./apps/runtime/src/services"),
			"@routes": path.resolve(__dirname, "./apps/runtime/src/routes"),
			"@web": path.resolve(__dirname, "./apps/runtime/src/web"),
		},
	},
});
