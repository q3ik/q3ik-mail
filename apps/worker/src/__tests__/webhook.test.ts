import { describe, it, expect, vi, type MockedClass } from 'vitest';
import { Resend } from 'resend';
import worker from '../index';

// Mock the Resend SDK to avoid real API calls in CI
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    webhooks: {
      verify: vi.fn().mockResolvedValue({
        type: 'email.received',
        data: { email_id: 'resend-test-id' },
      }),
    },
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

function makeRequest(body: string, headers: Record<string, string> = {}) {
  return new Request('https://worker.example.com/', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('webhook handler', () => {
  it('returns 405 for non-POST requests', async () => {
    const req = new Request('https://worker.example.com/', { method: 'GET' });
    const res = await worker.fetch(req, mockEnv);
    expect(res.status).toBe(405);
  });

  it('returns 401 when resend.webhooks.verify throws', async () => {
    const MockedResend = Resend as MockedClass<typeof Resend>;
    MockedResend.mockImplementationOnce(() => ({
      webhooks: { verify: vi.fn().mockRejectedValueOnce(new Error('bad sig')) },
      emails: { receiving: { get: vi.fn() } },
    }) as unknown as Resend);
    const req = makeRequest('{"type":"email.received"}', {
      'svix-id': 'x', 'svix-timestamp': 'x', 'svix-signature': 'x',
    });
    const res = await worker.fetch(req, mockEnv);
    expect(res.status).toBe(401);
  });

  it('returns 200 and skips insert for non-email.received events', async () => {
    const MockedResend = Resend as MockedClass<typeof Resend>;
    MockedResend.mockImplementationOnce(() => ({
      webhooks: { verify: vi.fn().mockResolvedValueOnce({ type: 'email.delivered', data: {} }) },
      emails: { receiving: { get: vi.fn() } },
    }) as unknown as Resend);
    const req = makeRequest('{}');
    const res = await worker.fetch(req, mockEnv);
    expect(res.status).toBe(200);
  });

  it('returns 200 and inserts email on valid email.received event', async () => {
    const req = makeRequest(JSON.stringify({ type: 'email.received' }), {
      'svix-id': 'test', 'svix-timestamp': '123', 'svix-signature': 'sig',
    });
    const res = await worker.fetch(req, mockEnv);
    expect(res.status).toBe(200);
  });
});
