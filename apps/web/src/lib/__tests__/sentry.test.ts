import { afterEach, describe, expect, it, vi } from 'vitest';

const captureCloudflareException = vi.fn();
const captureNextException = vi.fn();

vi.mock('@sentry/cloudflare', () => ({
  captureException: captureCloudflareException,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: captureNextException,
}));

describe('captureException', () => {
  afterEach(() => {
    captureCloudflareException.mockReset();
    captureNextException.mockReset();
    delete (globalThis as typeof globalThis & { window?: Window }).window;
  });

  it('uses @sentry/cloudflare on the server', async () => {
    const { captureException } = await import('../sentry');
    const error = new Error('server');

    await captureException(error);

    expect(captureCloudflareException).toHaveBeenCalledWith(error);
    expect(captureNextException).not.toHaveBeenCalled();
  });

  it('uses @sentry/nextjs in the browser', async () => {
    const { captureException } = await import('../sentry');
    const error = new Error('client');

    (globalThis as typeof globalThis & { window?: Window }).window = {} as Window;

    await captureException(error);

    expect(captureNextException).toHaveBeenCalledWith(error);
    expect(captureCloudflareException).not.toHaveBeenCalled();
  });
});
