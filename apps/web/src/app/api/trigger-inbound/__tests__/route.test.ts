import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => {
  const run = vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } });
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

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({
    env: routeMocks.env,
  }),
}));

describe('POST /api/trigger-inbound', () => {
  // Save original NODE_ENV so tests that mutate it can restore it cleanly.
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.E2E_TEST_SECRET = 'secret-123';
    delete process.env.CF_PAGES_BRANCH;
    // Restore to the saved value rather than deleting — preserves Vitest's own setting.
    process.env.NODE_ENV = originalNodeEnv;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.CF_PAGES_BRANCH;
  });

  it('returns 401 when x-e2e-test-secret header is missing or wrong', async () => {
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

  it('returns 401 before checking deployment guard (auth-first order)', async () => {
    // Even with NODE_ENV=production, a missing secret must yield 401, not 403.
    process.env.NODE_ENV = 'production';
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/trigger-inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'from@example.com', to: 'to@example.com', subject: 'Hi', text: 'Body' }),
    });

    const res = await POST(req);

    expect(res.status).toBe(401);
  });

  it('returns 403 when NODE_ENV is production (authenticated request)', async () => {
    process.env.NODE_ENV = 'production';
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/trigger-inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-e2e-test-secret': 'secret-123',
      },
      body: JSON.stringify({ from: 'from@example.com', to: 'to@example.com', subject: 'Hi', text: 'Body' }),
    });

    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(routeMocks.prepare).not.toHaveBeenCalled();
  });

  it('returns 403 when CF_PAGES_BRANCH is trunk (authenticated request)', async () => {
    process.env.CF_PAGES_BRANCH = 'trunk';
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/trigger-inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-e2e-test-secret': 'secret-123',
      },
      body: JSON.stringify({ from: 'from@example.com', to: 'to@example.com', subject: 'Hi', text: 'Body' }),
    });

    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(routeMocks.prepare).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed from address', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/trigger-inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-e2e-test-secret': 'secret-123',
      },
      body: JSON.stringify({ from: 'not-an-email', to: 'to@example.com', subject: 'Hi', text: 'Body' }),
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'Invalid from address' });
    expect(routeMocks.prepare).not.toHaveBeenCalled();
  });

  it('returns 200 and persists inbound email with a valid secret', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/trigger-inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-e2e-test-secret': 'secret-123',
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

  it('stores a separate thread_id and message_id (not the same value)', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/trigger-inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-e2e-test-secret': 'secret-123',
      },
      body: JSON.stringify({
        from: 'from@example.com',
        to: 'to@example.com',
        subject: 'Threading test',
        text: 'Body',
      }),
    });

    await POST(req);

    // bind() is called with positional args: (id, resend_id, thread_id, from_address, ...)
    // thread_id is index 2, message_id is index 11. They must differ.
    const bindArgs: string[] = routeMocks.bind.mock.calls[0] as string[];
    const threadId = bindArgs[2];
    const messageId = bindArgs[11];
    expect(threadId).not.toBe(messageId);
    // thread_id must be a plain UUID, not an RFC 5322 message-ID (<...> format)
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('returns 400 when the JSON body is malformed', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/trigger-inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-e2e-test-secret': 'secret-123',
      },
      body: '{ invalid json }',
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'Invalid JSON body' });
    expect(routeMocks.prepare).not.toHaveBeenCalled();
  });
});
