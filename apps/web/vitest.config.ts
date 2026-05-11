import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    // Automatically apply happy-dom to all component test files so they don't
    // need a per-file `// @vitest-environment happy-dom` pragma. Any test file
    // outside this glob still runs in the default node environment.
    environmentMatchGlobs: [
      ['src/components/**/__tests__/**', 'happy-dom'],
    ],
    exclude: ['e2e/**', 'node_modules/**'],
    reporters: ['verbose', ['junit', { outputFile: 'test-results/junit.xml' }]],
    coverage: {
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
