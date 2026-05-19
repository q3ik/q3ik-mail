import { beforeEach, describe, it, expect, vi, type MockedClass } from 'vitest';
import type { NextRequest } from 'next/server';
import { Resend } from 'resend';
import type { CreateEmailOptions } from 'resend';

const routeMocks = vi.hoisted(() => {
  const captureException = vi.fn().mockResolvedValue(undefined);
  const insertRun = vi.fn().mockResolvedValue({ success: true });
  const insertBind = vi.fn().mockReturnValue({ run: insertRun });
  const updateRun = vi.fn().mockResolvedValue({ success: true });
  const updateBind = vi.fn().mockReturnValue({ run: updateRun });
  const selectFirst = vi.fn().mockResolvedValue(null);
  const selectBind = vi.fn().mockReturnValue({ first: selectFirst });
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const trimmed = sql.trimStart().toUpperCase();
    if (trimmed.startsWith('SELECT')) {
      return { bind: selectBind };
    }
    if (trimmed.startsWith('UPDATE')) {
      return { bind: updateBind };
    }
    return { bind: insertBind };
  });

  return {
    captureException,
    insertRun,
    insertBind,
    updateRun,
    updateBind,
    selectFirst,
    selectBind,
    prepare,
    env: {
      RESEND_API_KEY: 'test-key',
      DB: { prepare },
    },
  };
});

// Mock @opennextjs/cloudflare before importing the route
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({
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
    (args) => (args[0] as string).includes('INSERT INTO emails')
  );
  expect(insertIdx).toBeGreaterThanOrEqual(0);

  // SELECTs use selectBind, UPDATEs use updateBind, so insertBind only records INSERT parameter lists.
  const firstInsertBindCall = routeMocks.insertBind.mock.calls[0];
  expect(firstInsertBindCall).toBeDefined();
  return {
    sql: routeMocks.prepare.mock.calls[insertIdx][0] as string,
    boundValues: firstInsertBindCall as unknown[],
  };
}

function getUpdateCalls(): { sql: string; boundValues: unknown[] }[] {
  return (routeMocks.prepare.mock.calls as unknown[][])
    .filter((args) => (args[0] as string).trimStart().toUpperCase().startsWith('UPDATE'))
    .map((args, i) => ({
      sql: args[0] as string,
      boundValues: routeMocks.updateBind.mock.calls[i] as unknown[],
    }));
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
    routeMocks.updateRun.mockResolvedValue({ success: true });
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
      .mockReturnValueOnce('row-uuid')
      .mockReturnValueOnce('msg-uuid');
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

  it('returns 400 when references exceeds the max length cap', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({
        to: 'a@b.com',
        subject: 'Hi',
        content: 'Hello',
        replyToId: '<msg-2@example.com>',
        references: 'x'.repeat(2001),
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(400);
    expectFieldError(await res.json(), 'references');
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

  // ── Happy path & outbox pattern ────────────────────────────────────────────

  it('persists pending_send row before calling Resend, then updates to sent', async () => {
    const randomUuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('row-uuid')
      .mockReturnValueOnce('message-uuid');
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

      // Verify Resend was called with correct Message-ID
      const MockedResend = Resend as MockedClass<typeof Resend>;
      const sendSpy = MockedResend.mock.results[0]?.value.emails.send as ReturnType<typeof vi.fn>;
      const callArgs = sendSpy.mock.calls[0][0] as CreateEmailOptions;
      expect(callArgs.headers?.['Message-ID']).toBe('<message-uuid@q3ik.com>');

      // Step 2: Verify INSERT was called with pending_send and placeholder resend_id
      expect(routeMocks.insertBind).toHaveBeenCalledTimes(1);
      const { sql, boundValues } = getInsertCall();
      expect(sql).toContain("'pending_send'");
      expect(boundValues).toEqual([
        'row-uuid',
        'pending:row-uuid',             // placeholder resend_id
        '<message-uuid@q3ik.com>',      // threadId (new thread = messageId)
        'mail@q3ik.com',
        'q3ik Mail',
        'a@b.com',
        'Hi',
        'Hello',
        null,
        null,           // body_text_key (null — no R2 in test env)
        null,           // body_html_key
        '<message-uuid@q3ik.com>',
        null,
        null,
        0,
      ]);

      // Step 4: Verify UPDATE was called to finalise status + real resend_id
      expect(routeMocks.updateBind).toHaveBeenCalledTimes(1);
      const updates = getUpdateCalls();
      expect(updates).toHaveLength(1);
      expect(updates[0].sql).toContain("status = 'sent'");
      expect(updates[0].sql).toContain('resend_id = ?');
      expect(updates[0].boundValues).toEqual(['sent-id', 'row-uuid']);

      // No thread lookup for new thread (no replyToId)
      expect(routeMocks.selectBind).toHaveBeenCalledTimes(0);
    } finally {
      randomUuidSpy.mockRestore();
    }
  });

  it('returns generic error message when Resend API returns an error and marks row as send_failed', async () => {
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

    // Verify the row was marked as send_failed
    const updates = getUpdateCalls();
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain("'send_failed'");
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

  it('returns 500 when D1 INSERT for pending_send fails — no email sent', async () => {
    routeMocks.insertRun.mockRejectedValueOnce(new Error('db unavailable'));
    const MockedResend = Resend as MockedClass<typeof Resend>;
    const sendSpy = vi.fn().mockResolvedValue({ data: { id: 'sent-id' }, error: null });
    MockedResend.mockImplementationOnce(() => ({ emails: { send: sendSpy } }) as unknown as Resend);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { POST } = await import('../route');
      const req = new Request('http://localhost/api/send', {
        method: 'POST',
        body: JSON.stringify({ to: 'a@b.com', subject: 'Hi', content: 'Hello' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req as unknown as NextRequest);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.message).toBe('Failed to queue email for sending — please retry.');
      // Crucially: Resend was NOT called because the intent record failed
      expect(sendSpy).not.toHaveBeenCalled();
      expect(routeMocks.captureException).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns 500 with resend id when final UPDATE fails after send succeeds', async () => {
    routeMocks.updateRun.mockRejectedValueOnce(new Error('db unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { POST } = await import('../route');
      const req = new Request('http://localhost/api/send', {
        method: 'POST',
        body: JSON.stringify({ to: 'a@b.com', subject: 'Hi', content: 'Hello' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req as unknown as NextRequest);
      const MockedResend = Resend as MockedClass<typeof Resend>;
      const sendSpy = MockedResend.mock.results[0]?.value.emails.send as ReturnType<typeof vi.fn>;

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: { message: 'Email sent but failed to save — please refresh.' },
        id: 'sent-id',
      });
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(routeMocks.captureException).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('sets In-Reply-To and References headers when replyToId is provided', async () => {
    const MockedResend = Resend as MockedClass<typeof Resend>;
    const randomUuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('reply-row-uuid')
      .mockReturnValueOnce('reply-message-uuid');
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

      // Verify INSERT used resolved thread_id
      expect(routeMocks.insertBind).toHaveBeenCalledTimes(1);
      const { sql, boundValues } = getInsertCall();
      expect(sql).toContain("'pending_send'");
      expect(boundValues).toEqual([
        'reply-row-uuid',
        'pending:reply-row-uuid',        // placeholder resend_id
        'thread-123',                     // resolved from parent
        'mail@q3ik.com',
        'q3ik Mail',
        'a@b.com',
        'Re: Hi',
        'Hi back',
        null,
        null,           // body_text_key (null — no R2 in test env)
        null,           // body_html_key
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

    // Each ID: "<" + "x".repeat(200) + "-" + 3-digit suffix + "@example.com" + ">"
    //        = 1 + 200 + 1 + 3 + 12 + 1 = 218 chars (ASCII = 218 bytes).
    // Using padStart(3,'0') ensures every ID is exactly 218 chars regardless of n.
    // 10 IDs: 218 + 9*(1+218) = 218 + 9*219 = 2189 bytes > MAX_REFERENCES_BYTES (2000).
    // 9 IDs:  218 + 8*219 = 1970 bytes < MAX_REFERENCES_BYTES.
    // 10 IDs is well below MAX_REFERENCES_IDS (12), so only the byte cap fires.
    const makeId = (n: number) =>
      `<${'x'.repeat(200)}-${String(n).padStart(3, '0')}@example.com>`;
    const root = makeId(0);
    const tailIds = Array.from({ length: 8 }, (_, i) => makeId(i + 1));
    const replyToId = makeId(9);
    // references has root + tail-001..tail-008; replyToId = tail-009 → 10 IDs total
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
    // The byte cap (2000) forces the oldest tail ID (makeId(001)) to be dropped.
    // Expected: root + makeId(002)..makeId(009) = 9 IDs, 1970 bytes.
    const expectedIds = [root, ...Array.from({ length: 8 }, (_, i) => makeId(i + 2))];
    expect(callArgs.headers?.['References']).toBe(expectedIds.join(' '));
  });

  it('handles Resend returning success without an id gracefully', async () => {
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
      // INSERT for pending_send should still have been called
      expect(routeMocks.insertBind).toHaveBeenCalledTimes(1);
      // UPDATE should mark as 'sent' even without a real resend_id
      expect(routeMocks.updateBind).toHaveBeenCalledTimes(1);
      const updates = getUpdateCalls();
      expect(updates[0].sql).toContain("status = 'sent'");
      expect(updates[0].sql).not.toContain('resend_id');
      expect(warnSpy).toHaveBeenCalledWith(
        '[api/send] Resend returned success without an id; keeping placeholder resend_id'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
