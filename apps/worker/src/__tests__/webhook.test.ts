import { describe, it, expect, vi } from 'vitest';
import worker from '../index';

type WorkerFetch = NonNullable<typeof worker.fetch>;
type WorkerRequest = Parameters<WorkerFetch>[0];

// Mock svix — the worker uses `new Webhook(secret).verify()` directly.
// Mocking resend.webhooks.verify has no effect because the worker never calls it.
vi.mock('svix', () => ({
  Webhook: vi.fn().mockImplementation(() => ({
    verify: vi.fn().mockReturnValue({
      type: 'email.received',
      data: { email_id: 'resend-test-id' },
    }),
  })),
}));

// Mock the Resend SDK for the receiving API call (emails.receiving.get)
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: {
      receiving: {
        get: vi.fn().mockResolvedValue({
          from: 'Alice <alice@example.com>',
          to: ['you@q3ik.com'],
          subject: 'Test Subject',
          text: 'Hello',
          html: '<p>Hello</p>',
          headers: [],
        }),
      },
    },
  })),
}));

// Minimal mock Env — matches the Env interface in apps/worker/src/index.ts
const mockEnv = {
  RESEND_API_KEY: 'test-key',
  RESEND_WEBHOOK_SECRET: 'test-secret',
  DB: {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        run: async () => ({ success: true }),
      }),
    }),
  },
} as unknown as import('../index').Env;

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function makeRequest(body: string, headers: Record<string, string> = {}) {
  return new Request('https://worker.example.com/', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function fetchWorker(req: Request, env = mockEnv, ctx = mockCtx) {
  return worker.fetch!(req as WorkerRequest, env, ctx);
}

describe('webhook handler', () => {
  it('returns 405 for non-POST requests', async () => {
    const req = new Request('https://worker.example.com/', { method: 'GET' });
    const res = await fetchWorker(req);
    expect(res.status).toBe(405);
  });

  it('returns 401 when svix verification throws', async () => {
    const { Webhook } = await import('svix');
    (Webhook as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      verify: vi.fn().mockImplementationOnce(() => { throw new Error('bad sig'); }),
    }));
    const req = makeRequest('{"type":"email.received"}', {
      'svix-id': 'x', 'svix-timestamp': 'x', 'svix-signature': 'x',
    });
    const res = await fetchWorker(req);
    expect(res.status).toBe(401);
  });

  it('returns 200 and skips insert for non-email.received events', async () => {
    const { Webhook } = await import('svix');
    (Webhook as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      verify: vi.fn().mockReturnValueOnce({ type: 'email.delivered', data: {} }),
    }));
    const req = makeRequest('{}', {
      'svix-id': 'x', 'svix-timestamp': 'x', 'svix-signature': 'x',
    });
    const res = await fetchWorker(req);
    expect(res.status).toBe(200);
  });

  it('returns 200 and inserts email on valid email.received event', async () => {
    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await fetchWorker(req);
    expect(res.status).toBe(200);
  });

  it('extracts and persists References header from inbound email', async () => {
    const { Resend } = await import('resend');
    const bindSpy = vi.fn().mockReturnValue({
      first: async () => null,
      run: async () => ({ success: true }),
    });
    const prepareSpy = vi.fn().mockReturnValue({ bind: bindSpy });
    const envWithSpy = {
      ...mockEnv,
      DB: { prepare: prepareSpy },
    } as unknown as import('../index').Env;

    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Alice <alice@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Re: Hello',
            text: 'Reply body',
            html: null,
            headers: [
              { name: 'Message-ID', value: '<reply-123@mail.example.com>' },
              { name: 'In-Reply-To', value: '<root-456@mail.example.com>' },
              { name: 'References', value: '<root-456@mail.example.com>' },
            ],
          }),
        },
      },
    }));

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await fetchWorker(req as WorkerRequest, envWithSpy, mockCtx);
    expect(res.status).toBe(200);

    // Find the INSERT prepare call and its corresponding bind args
    const insertIdx = prepareSpy.mock.calls.findIndex((args: unknown[]) =>
      (args[0] as string).includes('INSERT OR IGNORE INTO emails')
    );
    expect(insertIdx).toBeGreaterThanOrEqual(0);

    const insertSql = prepareSpy.mock.calls[insertIdx][0] as string;
    const insertBindArgs = bindSpy.mock.calls[insertIdx] as unknown[];

    // Parse column names from the INSERT SQL to find the "references" position
    const colMatch = insertSql.match(/INSERT[^(]*\(([^)]+)\)/);
    expect(colMatch).not.toBeNull();
    const columns = colMatch![1].split(',').map((c) => c.trim().replace(/["'`]/g, ''));
    const referencesIdx = columns.indexOf('references');
    expect(referencesIdx).toBeGreaterThanOrEqual(0);

    expect(insertBindArgs[referencesIdx]).toBe('<root-456@mail.example.com>');
  });

  it('stores null for references when References header is absent', async () => {
    const { Resend } = await import('resend');
    const bindSpy = vi.fn().mockReturnValue({
      first: async () => null,
      run: async () => ({ success: true }),
    });
    const prepareSpy = vi.fn().mockReturnValue({ bind: bindSpy });
    const envWithSpy = {
      ...mockEnv,
      DB: { prepare: prepareSpy },
    } as unknown as import('../index').Env;

    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Bob <bob@example.com>',
            to: ['you@q3ik.com'],
            subject: 'No References header',
            text: 'Body',
            html: null,
            headers: [
              { name: 'Message-ID', value: '<new-789@mail.example.com>' },
            ],
          }),
        },
      },
    }));

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await fetchWorker(req as WorkerRequest, envWithSpy, mockCtx);
    expect(res.status).toBe(200);

    // Find the INSERT prepare call and its corresponding bind args
    const insertIdx = prepareSpy.mock.calls.findIndex((args: unknown[]) =>
      (args[0] as string).includes('INSERT OR IGNORE INTO emails')
    );
    expect(insertIdx).toBeGreaterThanOrEqual(0);

    const insertSql = prepareSpy.mock.calls[insertIdx][0] as string;
    const insertBindArgs = bindSpy.mock.calls[insertIdx] as unknown[];

    // Parse column names from the INSERT SQL to find the "references" position
    const colMatch = insertSql.match(/INSERT[^(]*\(([^)]+)\)/);
    expect(colMatch).not.toBeNull();
    const columns = colMatch![1].split(',').map((c) => c.trim().replace(/["'`]/g, ''));
    const referencesIdx = columns.indexOf('references');
    expect(referencesIdx).toBeGreaterThanOrEqual(0);

    expect(insertBindArgs[referencesIdx]).toBeNull();
  });
});
