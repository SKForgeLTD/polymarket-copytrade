import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.config.ts',
        'src/test-utils/',
        'src/index.ts', // Main entry point - integration tested
        'src/cli/', // CLI commands - integration tested
        'src/types/', // Type definitions
        'src/logger/', // Simple logger wrapper
      ],
      all: true,
      lines: 80,
      functions: 80,
      branches: 75,
      statements: 80,
    },
    // Increase timeout for async tests
    testTimeout: 10000,
  },
});
