import { test, expect } from '@playwright/test';

// NOTE: These E2E tests require the inbox UI from Issue q3ik/q3ik-mail#5.
// The mail-list-item and mail-display tests are skipped until Issue #5 lands
// (adds data-testid="mail-list-item" to MailList and data-testid="mail-display"
// to the reading pane).

test.describe('Inbox', () => {
  test('inbox page loads without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('/');
    await expect(page).toHaveTitle(/q3ik-mail/i);
    // Filter out known Sentry no-DSN warning emitted when SENTRY_DSN is not
    // configured in CI — these are not application errors.
    const realErrors = errors.filter(
      (e) => !e.toLowerCase().includes('sentry') && !e.toLowerCase().includes('dsn')
    );
    expect(realErrors).toHaveLength(0);
  });

  test.skip('mail list renders emails from D1', async ({ page }) => {
    // Pending: requires data-testid="mail-list-item" from Issue #5
    await page.goto('/');
    await expect(page.locator('[data-testid="mail-list-item"]').first()).toBeVisible({ timeout: 10000 });
  });

  test.skip('clicking an email opens the reading pane', async ({ page }) => {
    // Pending: requires data-testid="mail-display" from Issue #5
    await page.goto('/');
    await page.locator('[data-testid="mail-list-item"]').first().click();
    await expect(page.locator('[data-testid="mail-display"]')).toBeVisible();
  });

  test('compose button opens dialog', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /compose/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel(/to/i)).toBeVisible();
  });

  test('compose dialog closes on cancel', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /compose/i }).click();
    await page.getByRole('button', { name: /cancel/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });
});
