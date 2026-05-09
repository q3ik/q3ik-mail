import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    exclude: ['e2e/**', 'node_modules/**'],
    reporters: ['verbose', ['junit', { outputFile: 'test-results/junit.xml' }]],
    coverage: {
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
