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
  const firstInsertBindCall = routeMocks.insertBind.mock.calls[0];
  expect(firstInsertBindCall).toBeDefined();
  return {
    sql: routeMocks.prepare.mock.calls[insertIdx][0] as string,
    boundValues: firstInsertBindCall as unknown[],
  };
}

// ─── Unified error shape helpers ───────────────────────────────────────────
// All 400 responses must conform to:
//   { error: { message: string; fieldErrors?: Record<string, string[]> } }

function expectJsonParseError(body: unknown) {
  expect(body).toHaveProperty('error');
  const err = (body as { error: { message: string } }).error;
  expect(typeof err.message).toBe('string');
  expect(err.message).toBe('Invalid JSON body');
  // JSON parse errors must NOT expose fieldErrors
  expect(err).not.toHaveProperty('fieldErrors');
}

function expectFieldError(body: unknown, field: string) {
  expect(body).toHaveProperty('error');
  const err = (body as { error: { message: string; fieldErrors: Record<string, string[]> } }).error;
  expect(typeof err.message).toBe('string');
  expect(err).toHaveProperty('fieldErrors');
  expect(err.fieldErrors).toHaveProperty(field);
}
// ───────────────────────────────────────────────────────────────────────────

describe('POST /api/send', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    routeMocks.captureException.mockResolvedValue(undefined);
    routeMocks.insertRun.mockResolvedValue({ success: true });
    routeMocks.selectFirst.mockResolvedValue(null);
  });

  // ── Unified error shape contract ──────────────────────────────────────────

  it('returns 400 with unified error shape when "to" is missing', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({ subject: 'Hi', content: 'Hello' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(400);
    expectFieldError(await res.json(), 'to');
  });

  it('returns 400 with unified error shape when "subject" is missing', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({ to: 'a@b.com', content: 'Hello' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(400);
    expectFieldError(await res.json(), 'subject');
  });

  it('returns 400 with unified error shape when "content" is an empty string', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({ to: 'a@b.com', subject: 'Hi', content: '' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(400);
    expectFieldError(await res.json(), 'content');
  });

  it('returns 400 with unified error shape when "content" is whitespace-only', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({ to: 'a@b.com', subject: 'Hi', content: '   ' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(400);
    expectFieldError(await res.json(), 'content');
  });

  it('returns 400 with unified error shape when "subject" is whitespace-only', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({ to: 'a@b.com', subject: '   ', content: 'Hello' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(400);
    expectFieldError(await res.json(), 'subject');
  });

  it('returns 400 with unified error shape when "to" is not a valid email address', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({ to: 'not-an-email', subject: 'Hi', content: 'Hello' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(400);
    expectFieldError(await res.json(), 'to');
  });

  it('returns 400 with unified error shape for malformed JSON body', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: '{not valid json',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(400);
    expectJsonParseError(await res.json());
  });

  // ── null optional fields are accepted (nullish() contract) ────────────────

  it('accepts null replyToId and null references (nullish normalised to undefined)', async () => {
    const randomUuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('msg-uuid')
      .mockReturnValueOnce('row-uuid');
    try {
      const { POST } = await import('../route');
      const req = new Request('http://localhost/api/send', {
        method: 'POST',
        body: JSON.stringify({ to: 'a@b.com', subject: 'Hi', content: 'Hello', replyToId: null, references: null }),
        headers: { 'Content-Type': 'application/json' },
      });
      const res = await POST(req as unknown as NextRequest);
      expect(res.status).toBe(200);
      // Should be treated as a new thread (no In-Reply-To / References headers)
      const MockedResend = Resend as MockedClass<typeof Resend>;
      const sendSpy = MockedResend.mock.results[0]?.value.emails.send as ReturnType<typeof vi.fn>;
      const callArgs = sendSpy.mock.calls[0][0] as CreateEmailOptions;
      expect(callArgs.headers?.['In-Reply-To']).toBeUndefined();
      expect(callArgs.headers?.['References']).toBeUndefined();
    } finally {
      randomUuidSpy.mockRestore();
    }
  });

  it('treats empty-string replyToId as absent (min(1) + nullish)', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({ to: 'a@b.com', subject: 'Hi', content: 'Hello', replyToId: '' }),
      headers: { 'Content-Type': 'application/json' },
    });
    // An empty string hits min(1) inside the nullish chain — fails validation
    const res = await POST(req as unknown as NextRequest);
    // empty string after trim is 0 length, so min(1) rejects it
    expect(res.status).toBe(400);
    expectFieldError(await res.json(), 'replyToId');
  });

  // ── Boundary cases for invalid email formats ──────────────────────────────

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
    expectFieldError(await res.json(), 'to');
  });

  // Plus-addressing must pass — used by Resend test inboxes and common in production
  it('accepts plus-addressed email (user+tag@sub.domain.com) as valid', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({ to: 'user+tag@sub.domain.com', subject: 'Hi', content: 'Hello' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
  });

  // ── Happy path & persistence ───────────────────────────────────────────────

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

      expect(routeMocks.insertBind).toHaveBeenCalledTimes(1);
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

  it('returns 500 and skips send when thread lookup fails', async () => {
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

      expect(routeMocks.insertBind).toHaveBeenCalledTimes(1);
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

  it('omits References header when replyToId is absent', async () => {
    const MockedResend = Resend as MockedClass<typeof Resend>;
    const sendSpy = vi.fn().mockResolvedValue({ data: { id: 'r0' }, error: null });
    MockedResend.mockImplementationOnce(() => ({ emails: { send: sendSpy } }) as unknown as Resend);

    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({
        to: 'a@b.com',
        subject: 'Hi',
        content: 'Hello',
        references: '<root@example.com>',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    await POST(req as unknown as NextRequest);
    const callArgs = sendSpy.mock.calls[0][0] as CreateEmailOptions;
    expect(callArgs.headers?.['References']).toBeUndefined();
  });

  it('keeps full short references chain when below caps (no truncation)', async () => {
    const MockedResend = Resend as MockedClass<typeof Resend>;
    const sendSpy = vi.fn().mockResolvedValue({ data: { id: 'r2' }, error: null });
    MockedResend.mockImplementationOnce(() => ({ emails: { send: sendSpy } }) as unknown as Resend);

    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({
        to: 'a@b.com',
        subject: 'Re: Hi',
        content: 'Hi back',
        replyToId: '<msg-3@example.com>',
        references: '<root@example.com> <msg-1@example.com> <msg-2@example.com>',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    await POST(req as unknown as NextRequest);
    const callArgs = sendSpy.mock.calls[0][0] as CreateEmailOptions;
    expect(callArgs.headers?.['References']).toBe(
      '<root@example.com> <msg-1@example.com> <msg-2@example.com> <msg-3@example.com>'
    );
  });

  it('truncates long references chain preserving root and most recent ancestors', async () => {
    const MockedResend = Resend as MockedClass<typeof Resend>;
    const sendSpy = vi.fn().mockResolvedValue({ data: { id: 'r3' }, error: null });
    MockedResend.mockImplementationOnce(() => ({ emails: { send: sendSpy } }) as unknown as Resend);

    const root = '<root@example.com>';
    const mid = Array.from({ length: 20 }, (_, i) => `<msg-${i + 1}@example.com>`).join(' ');

    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({
        to: 'a@b.com',
        subject: 'Re: Hi',
        content: 'Hi back',
        replyToId: '<msg-21@example.com>',
        references: `${root} ${mid}`,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    await POST(req as unknown as NextRequest);
    const callArgs = sendSpy.mock.calls[0][0] as CreateEmailOptions;
    expect(callArgs.headers?.['References']).toBe(
      '<root@example.com> <msg-11@example.com> <msg-12@example.com> <msg-13@example.com> <msg-14@example.com> <msg-15@example.com> <msg-16@example.com> <msg-17@example.com> <msg-18@example.com> <msg-19@example.com> <msg-20@example.com> <msg-21@example.com>'
    );
  });

  it('deduplicates root when it reappears in the tail', async () => {
    const MockedResend = Resend as MockedClass<typeof Resend>;
    const sendSpy = vi.fn().mockResolvedValue({ data: { id: 'r4' }, error: null });
    MockedResend.mockImplementationOnce(() => ({ emails: { send: sendSpy } }) as unknown as Resend);

    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({
        to: 'a@b.com',
        subject: 'Re: Hi',
        content: 'Hi back',
        replyToId: '<msg-3@example.com>',
        references: '<root@example.com> <msg-1@example.com> <root@example.com> <msg-2@example.com>',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    await POST(req as unknown as NextRequest);
    const callArgs = sendSpy.mock.calls[0][0] as CreateEmailOptions;
    expect(callArgs.headers?.['References']).toBe(
      '<root@example.com> <msg-1@example.com> <msg-2@example.com> <msg-3@example.com>'
    );
  });

  it('enforces byte-length cap dropping oldest tail IDs when below ID count cap', async () => {
    const MockedResend = Resend as MockedClass<typeof Resend>;
    const sendSpy = vi.fn().mockResolvedValue({ data: { id: 'r5' }, error: null });
    MockedResend.mockImplementationOnce(() => ({ emails: { send: sendSpy } }) as unknown as Resend);

    // Each ID is 216 chars: "<" + "x".repeat(200) + "-N" + "@example.com" + ">"
    // = 1 + 200 + 2 + 12 + 1 = 216 chars.
    // 10 such IDs have total byte length 216 + 9*217 = 2169 > MAX_REFERENCES_BYTES (2000),
    // while staying well below MAX_REFERENCES_IDS (12), so only the byte cap fires.
    const makeId = (n: number) => `<${'x'.repeat(200)}-${n}@example.com>`;
    const root = makeId(0);
    const tailIds = Array.from({ length: 8 }, (_, i) => makeId(i + 1));
    const replyToId = makeId(9);
    // references has root + tail-1..tail-8; replyToId = tail-9 → 10 IDs total
    const references = [root, ...tailIds].join(' ');

    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({
        to: 'a@b.com',
        subject: 'Re: Hi',
        content: 'Hi back',
        replyToId,
        references,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    await POST(req as unknown as NextRequest);
    const callArgs = sendSpy.mock.calls[0][0] as CreateEmailOptions;
    // The byte cap (2000) forces the oldest tail ID (makeId(1)) to be dropped.
    // Expected: root + makeId(2)..makeId(9) = 9 IDs, 216 + 8*217 = 1952 bytes.
    const expectedIds = [root, ...Array.from({ length: 8 }, (_, i) => makeId(i + 2))];
    expect(callArgs.headers?.['References']).toBe(expectedIds.join(' '));
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
      expect(routeMocks.captureException).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[api/send] Resend returned success without an id; skipping sent-email persistence'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
