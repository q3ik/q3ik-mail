import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const persistTo = path.resolve(__dirname, '../../.wrangler/state');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'test-results/e2e-junit.xml' }],
  ],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // Playwright starts this command, waits for a real HTTP 200 on the
    // url below, and tears it down after all tests finish.
    command: [
      'pnpm exec wrangler pages dev .vercel/output/static',
      '--port 3000',
      '--compatibility-flag nodejs_compat',
      `--persist-to ${persistTo}`,
    ].join(' '),
    url: 'http://localhost:3000',
    // In CI always start fresh; locally re-use an already-running server.
    reuseExistingServer: !process.env.CI,
    // Give wrangler up to 60 s to finish initialising before failing.
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
