import { beforeEach, describe, it, expect, vi, type MockedClass } from 'vitest';
import type { NextRequest } from 'next/server';
import { Resend } from 'resend';
import type { CreateEmailOptions } from 'resend';

const routeMocks = vi.hoisted(() => {
  const captureException = vi.fn().mockResolvedValue(undefined);
  const insertRun = vi.fn().mockResolvedValue({ success: true });
  const insertBind = vi.fn().mockReturnValue({ run: insertRun });
  const selectFirst = vi.fn().mockResolvedValue(null);
  const selectBind = vi.fn().mockReturnValue({ first: selectFirst });
  const prepare = vi.fn().mockImplementation((sql: string) => {
    if (sql.trimStart().toUpperCase().startsWith('SELECT')) {
      return { bind: selectBind };
    }
    return { bind: insertBind };
  });

  return {
    captureException,
    insertRun,
    insertBind,
    selectFirst,
    selectBind,
    prepare,
    env: {
      RESEND_API_KEY: 'test-key',
      DB: { prepare },
    },
  };
});

// Mock @cloudflare/next-on-pages before importing the route
vi.mock('@cloudflare/next-on-pages', () => ({
  getRequestContext: () => ({
    env: routeMocks.env,
  }),
}));

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: {
      send: vi.fn().mockResolvedValue({ data: { id: 'sent-id' }, error: null }),
    },
  })),
}));

vi.mock('@/lib/sentry', () => ({
  captureException: routeMocks.captureException,
}));

function getInsertCall(): { sql: string; boundValues: unknown[] } {
  const insertIdx = (routeMocks.prepare.mock.calls as unknown[][]).findIndex(
    (args) => (args[0] as string).includes('INSERT OR IGNORE INTO emails')
  );
  expect(insertIdx).toBeGreaterThanOrEqual(0);

  // SELECTs use selectBind, so insertBind only records INSERT parameter lists.
  expect(routeMocks.insertBind).toHaveBeenCalledTimes(1);
  const firstInsertBindCall = routeMocks.insertBind.mock.calls[0];
  expect(firstInsertBindCall).toBeDefined();
  return {
    sql: routeMocks.prepare.mock.calls[insertIdx][0] as string,
    boundValues: firstInsertBindCall as unknown[],
  };
}

describe('POST /api/send', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    routeMocks.captureException.mockResolvedValue(undefined);
    routeMocks.insertRun.mockResolvedValue({ success: true });
    routeMocks.selectFirst.mockResolvedValue(null);
  });

  it('returns 400 when "to" is missing', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({ subject: 'Hi', content: 'Hello' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(400);
  });

  it('returns 400 when "subject" is missing', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({ to: 'a@b.com', content: 'Hello' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(400);
  });

  it('returns 400 when "to" is not a valid email address', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({ to: 'not-an-email', subject: 'Hi', content: 'Hello' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid or missing email address');
  });

  // Boundary cases that the original indexOf-based check passed incorrectly
  it.each([
    ['trailing dot in domain', 'a@b.'],
    ['leading dot in domain', 'a@.b.com'],
    ['space in domain', 'a@ b.com'],
    ['multiple @ signs', 'a@b@c.com'],
    ['empty local part', '@b.com'],
    ['empty string', ''],
  ])('returns 400 for invalid email: %s (%s)', async (_label, address) => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({ to: address, subject: 'Hi', content: 'Hello' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid or missing email address');
  });

  it('returns 200 with email id on success and persists the sent email', async () => {
    const randomUuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('message-uuid')
      .mockReturnValueOnce('row-uuid');
    try {
      const { POST } = await import('../route');
      const req = new Request('http://localhost/api/send', {
        method: 'POST',
        body: JSON.stringify({ to: 'a@b.com', subject: 'Hi', content: 'Hello' }),
        headers: { 'Content-Type': 'application/json' },
      });
      const res = await POST(req as unknown as NextRequest);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe('sent-id');

      const MockedResend = Resend as MockedClass<typeof Resend>;
      const sendSpy = MockedResend.mock.results[0]?.value.emails.send as ReturnType<typeof vi.fn>;
      const callArgs = sendSpy.mock.calls[0][0] as CreateEmailOptions;
      expect(callArgs.headers?.['Message-ID']).toBe('<message-uuid@q3ik.com>');

      const { sql, boundValues } = getInsertCall();
      expect(sql).toContain('1, 1, ?');
      expect(boundValues).toEqual([
        'row-uuid',
        'sent-id',
        '<message-uuid@q3ik.com>',
        'mail@q3ik.com',
        'q3ik Mail',
        'a@b.com',
        'Hi',
        'Hello',
        null,
        '<message-uuid@q3ik.com>',
        null,
        null,
        0,
      ]);
      expect(routeMocks.selectBind).toHaveBeenCalledTimes(0);
    } finally {
      randomUuidSpy.mockRestore();
    }
  });

  it('returns generic error message when Resend API returns an error', async () => {
    const MockedResend = Resend as MockedClass<typeof Resend>;
    const resendError = { message: 'Rate limit exceeded', name: 'rate_limit_exceeded', statusCode: 429 };
    const sendSpy = vi.fn().mockResolvedValue({ data: null, error: resendError });
    MockedResend.mockImplementationOnce(() => ({ emails: { send: sendSpy } }) as unknown as Resend);
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({ to: 'a@b.com', subject: 'Hi', content: 'Hello' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Failed to send email');
  });

  it('returns 500 without sending when thread lookup fails before send', async () => {
    routeMocks.selectFirst.mockRejectedValueOnce(new Error('thread lookup failed'));
    const MockedResend = Resend as MockedClass<typeof Resend>;
    const sendSpy = vi.fn().mockResolvedValue({ data: { id: 'sent-id' }, error: null });
    MockedResend.mockImplementationOnce(() => ({ emails: { send: sendSpy } }) as unknown as Resend);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { POST } = await import('../route');
      const req = new Request('http://localhost/api/send', {
        method: 'POST',
        body: JSON.stringify({
          to: 'a@b.com',
          subject: 'Re: Hi',
          content: 'Hi back',
          replyToId: '<msg-1@example.com>',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req as unknown as NextRequest);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to send email' });
      expect(sendSpy).not.toHaveBeenCalled();
      expect(routeMocks.insertBind).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith('Failed to send email:', expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('sets In-Reply-To and References headers when replyToId is provided', async () => {
    const MockedResend = Resend as MockedClass<typeof Resend>;
    const randomUuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('reply-message-uuid')
      .mockReturnValueOnce('reply-row-uuid');
    routeMocks.selectFirst.mockResolvedValueOnce({ thread_id: 'thread-123' });
    const sendSpy = vi.fn().mockResolvedValue({ data: { id: 'r1' }, error: null });
    MockedResend.mockImplementationOnce(() => ({ emails: { send: sendSpy } }) as unknown as Resend);
    try {
      const { POST } = await import('../route');
      const req = new Request('http://localhost/api/send', {
        method: 'POST',
        body: JSON.stringify({
          to: 'a@b.com',
          subject: 'Re: Hi',
          content: 'Hi back',
          replyToId: '<msg-1@example.com>',
          references: '<root@example.com>',
        }),
        headers: { 'Content-Type': 'application/json' },
      });
      await POST(req as unknown as NextRequest);
      const callArgs = sendSpy.mock.calls[0][0] as CreateEmailOptions;
      expect(callArgs.headers?.['Message-ID']).toBe('<reply-message-uuid@q3ik.com>');
      expect(callArgs.headers?.['In-Reply-To']).toBe('<msg-1@example.com>');
      expect(callArgs.headers?.['References']).toBe('<root@example.com> <msg-1@example.com>');
      expect(routeMocks.selectBind).toHaveBeenCalledWith('<msg-1@example.com>');

      const { sql, boundValues } = getInsertCall();
      expect(sql).toContain('1, 1, ?');
      expect(boundValues).toEqual([
        'reply-row-uuid',
        'r1',
        'thread-123',
        'mail@q3ik.com',
        'q3ik Mail',
        'a@b.com',
        'Re: Hi',
        'Hi back',
        null,
        '<reply-message-uuid@q3ik.com>',
        '<msg-1@example.com>',
        '<root@example.com> <msg-1@example.com>',
        0,
      ]);
      expect(routeMocks.selectBind).toHaveBeenCalledTimes(1);
    } finally {
      randomUuidSpy.mockRestore();
    }
  });

  it('still returns 200 when D1 persistence fails after send succeeds', async () => {
    routeMocks.insertRun.mockRejectedValueOnce(new Error('db unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { POST } = await import('../route');
      const req = new Request('http://localhost/api/send', {
        method: 'POST',
        body: JSON.stringify({ to: 'a@b.com', subject: 'Hi', content: 'Hello' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req as unknown as NextRequest);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: 'sent-id' });
      expect(errorSpy).toHaveBeenCalledWith(
        '[api/send] Failed to persist sent email to D1:',
        expect.any(Error)
      );
      expect(routeMocks.captureException).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('skips persistence when Resend returns success without an id', async () => {
    const MockedResend = Resend as MockedClass<typeof Resend>;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sendSpy = vi.fn().mockResolvedValue({ data: {}, error: null });
    MockedResend.mockImplementationOnce(() => ({ emails: { send: sendSpy } }) as unknown as Resend);
    try {
      const { POST } = await import('../route');
      const req = new Request('http://localhost/api/send', {
        method: 'POST',
        body: JSON.stringify({ to: 'a@b.com', subject: 'Hi', content: 'Hello' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req as unknown as NextRequest);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: null });
      expect(routeMocks.insertBind).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[api/send] Resend returned success without an id; skipping sent-email persistence'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
