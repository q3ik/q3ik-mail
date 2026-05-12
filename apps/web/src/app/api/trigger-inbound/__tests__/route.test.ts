import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => {
  const run = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });

  return {
    run,
    bind,
    prepare,
    env: {
      DB: { prepare },
    },
  };
});

vi.mock('@cloudflare/next-on-pages', () => ({
  getRequestContext: () => ({
    env: routeMocks.env,
  }),
}));

describe('POST /api/trigger-inbound', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.E2E_TEST_SECRET = 'secret-123';
    delete process.env.CF_PAGES_BRANCH;
    delete process.env.NODE_ENV;
  });

  it('returns 401 when TEST_SECRET header is missing or wrong', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/trigger-inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'from@example.com', to: 'to@example.com', subject: 'Hi', text: 'Body' }),
    });

    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(routeMocks.prepare).not.toHaveBeenCalled();
  });

  it('returns 403 in production or trunk deployments', async () => {
    process.env.NODE_ENV = 'production';
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/trigger-inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        TEST_SECRET: 'secret-123',
      },
      body: JSON.stringify({ from: 'from@example.com', to: 'to@example.com', subject: 'Hi', text: 'Body' }),
    });

    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(routeMocks.prepare).not.toHaveBeenCalled();
  });

  it('returns 200 and persists inbound email with a valid secret', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/trigger-inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        TEST_SECRET: 'secret-123',
      },
      body: JSON.stringify({
        from: 'from@example.com',
        to: 'to@example.com',
        subject: 'Inbound subject',
        text: 'Inbound body',
      }),
    });

    const res = await POST(req);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(routeMocks.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT OR IGNORE INTO emails'));
    expect(routeMocks.bind).toHaveBeenCalledTimes(1);
    expect(routeMocks.run).toHaveBeenCalledTimes(1);
  });
});
