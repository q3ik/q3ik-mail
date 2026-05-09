import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    reporters: ['verbose', ['junit', { outputFile: 'test-results/junit.xml' }]],
    coverage: {
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
    },
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
});
