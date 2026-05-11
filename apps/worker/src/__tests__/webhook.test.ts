import { describe, it, expect, vi } from 'vitest';
import worker from '../index';
import { parseFrom } from '../utils/parseFrom';

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

function fetchWorker(req: Request) {
  return worker.fetch!(req as WorkerRequest, mockEnv, mockCtx);
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
});

describe('parseFrom', () => {
  it('parses unquoted display name', () => {
    expect(parseFrom('Alice <alice@example.com>')).toEqual({ name: 'Alice', address: 'alice@example.com' });
  });

  it('parses quoted display name with comma (RFC 5322)', () => {
    expect(parseFrom('"Smith, John" <john@example.com>')).toEqual({ name: 'Smith, John', address: 'john@example.com' });
  });

  it('parses angle-bracket-only form with no display name', () => {
    // Valid RFC 5322 form: <alice@example.com> — no display name, name must be null
    expect(parseFrom('<alice@example.com>')).toEqual({ name: null, address: 'alice@example.com' });
  });

  it('parses plain email address with no display name', () => {
    expect(parseFrom('alice@example.com')).toEqual({ name: null, address: 'alice@example.com' });
  });

  it('trims surrounding whitespace', () => {
    expect(parseFrom('  Alice <alice@example.com>  ')).toEqual({ name: 'Alice', address: 'alice@example.com' });
  });

  it('returns empty address for empty input', () => {
    expect(parseFrom('')).toEqual({ name: null, address: '' });
  });
});

describe('threading', () => {
  it('joins existing thread when In-Reply-To parent is found', async () => {
    const { Resend } = await import('resend');
    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Alice <alice@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Re: Test',
            text: 'Reply',
            html: '<p>Reply</p>',
            headers: [
              { name: 'In-Reply-To', value: '<parent@example.com>' },
              { name: 'Message-ID', value: '<reply@example.com>' },
            ],
          }),
        },
      },
    }));

    let insertedThreadId: unknown;
    const customEnv = {
      RESEND_API_KEY: 'test-key',
      RESEND_WEBHOOK_SECRET: 'test-secret',
      DB: {
        prepare: (sql: string) => {
          if (sql.includes('SELECT')) {
            return { bind: () => ({ first: async () => ({ thread_id: 'existing-thread-id' }), run: async () => ({ success: true }) }) };
          }
          return {
            bind: (...args: unknown[]) => ({
              first: async () => null,
              run: async () => { insertedThreadId = args[2]; return { success: true }; },
            }),
          };
        },
      },
    } as unknown as import('../index').Env;

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await worker.fetch!(req as WorkerRequest, customEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(insertedThreadId).toBe('existing-thread-id');
  });

  it('sets needs_rethreading=1 when In-Reply-To parent is not found', async () => {
    const { Resend } = await import('resend');
    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: 'Alice <alice@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Re: Orphan',
            text: 'Reply',
            html: '<p>Reply</p>',
            headers: [
              { name: 'In-Reply-To', value: '<missing@example.com>' },
            ],
          }),
        },
      },
    }));

    let insertedNeedsRethreading: unknown;
    const customEnv = {
      RESEND_API_KEY: 'test-key',
      RESEND_WEBHOOK_SECRET: 'test-secret',
      DB: {
        prepare: (sql: string) => {
          if (sql.includes('SELECT')) {
            // Simulate parent not found for the thread-lookup query
            return { bind: () => ({ first: async () => null }) };
          }
          return {
            bind: (...args: unknown[]) => ({
              first: async () => null,
              run: async () => {
                // INSERT bind order (0-based):
                // 0:id, 1:resend_id, 2:thread_id, 3:from_address, 4:from_name,
                // 5:to_address, 6:subject, 7:body_text, 8:body_html,
                // 9:message_id, 10:in_reply_to, 11:needs_rethreading
                insertedNeedsRethreading = args[11];
                return { success: true };
              },
            }),
          };
        },
      },
    } as unknown as import('../index').Env;

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await worker.fetch!(req as WorkerRequest, customEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(insertedNeedsRethreading).toBe(1);
  });

  it('stores correct from_name and from_address for quoted display name with comma', async () => {
    const { Resend } = await import('resend');
    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: '"Smith, John" <john@example.com>',
            to: ['you@q3ik.com'],
            subject: 'Hello',
            text: 'Hi',
            html: '<p>Hi</p>',
            headers: [],
          }),
        },
      },
    }));

    let insertedFromAddress: unknown;
    let insertedFromName: unknown;
    const customEnv = {
      RESEND_API_KEY: 'test-key',
      RESEND_WEBHOOK_SECRET: 'test-secret',
      DB: {
        prepare: () => ({
          bind: (...args: unknown[]) => ({
            first: async () => null,
            // INSERT bind order (0-based):
            // 0:id, 1:resend_id, 2:thread_id, 3:from_address, 4:from_name, ...
            run: async () => { insertedFromAddress = args[3]; insertedFromName = args[4]; return { success: true }; },
          }),
        }),
      },
    } as unknown as import('../index').Env;

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await worker.fetch!(req as WorkerRequest, customEnv, mockCtx);
    expect(res.status).toBe(200);
    expect(insertedFromAddress).toBe('john@example.com');
    expect(insertedFromName).toBe('Smith, John');
  });

  it('returns 400 when from address is missing or unparseable', async () => {
    const { Resend } = await import('resend');
    (Resend as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      emails: {
        receiving: {
          get: vi.fn().mockResolvedValue({
            from: '',   // empty from field — parseFrom returns address: ''
            to: ['you@q3ik.com'],
            subject: 'No Sender',
            text: 'Hi',
            html: '<p>Hi</p>',
            headers: [],
          }),
        },
      },
    }));

    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await worker.fetch!(req as WorkerRequest, mockEnv, mockCtx);
    expect(res.status).toBe(400);
  });
});
