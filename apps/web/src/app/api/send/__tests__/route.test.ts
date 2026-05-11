import { beforeEach, describe, it, expect, vi, type MockedClass } from 'vitest';
import type { NextRequest } from 'next/server';
import { Resend } from 'resend';
import type { CreateEmailOptions } from 'resend';

const routeMocks = vi.hoisted(() => {
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

function getInsertArgs(): { columns: string[]; values: unknown[] } {
  const insertIdx = (routeMocks.prepare.mock.calls as unknown[][]).findIndex(
    (args) => (args[0] as string).includes('INSERT OR IGNORE INTO emails')
  );
  expect(insertIdx).toBeGreaterThanOrEqual(0);

  const insertSql = routeMocks.prepare.mock.calls[insertIdx][0] as string;
  const colMatch = insertSql.match(/INSERT[^(]*\(([^)]+)\)/);
  expect(colMatch).not.toBeNull();
  const allColumns = colMatch![1]
    .split(',')
    .map((column) => column.trim().replace(/["'`]/g, ''));

  const valuesMatch = insertSql.match(/VALUES\s*\(([^)]+)\)/i);
  expect(valuesMatch).not.toBeNull();
  const valueTokens = valuesMatch![1].split(',').map((value) => value.trim());

  const boundValues = routeMocks.insertBind.mock.calls[0] as unknown[];
  const columnToValue: Record<string, unknown> = {};
  let paramIdx = 0;

  for (let i = 0; i < valueTokens.length; i++) {
    if (valueTokens[i] === '?') {
      columnToValue[allColumns[i]] = boundValues[paramIdx++];
    } else {
      const literal = valueTokens[i];
      columnToValue[allColumns[i]] = Number.isNaN(Number(literal))
        ? literal
        : Number(literal);
    }
  }

  return {
    columns: allColumns,
    values: allColumns.map((column) => columnToValue[column]),
  };
}

describe('POST /api/send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('message-uuid')
      .mockReturnValueOnce('row-uuid');
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

    const { columns, values } = getInsertArgs();
    expect(values[columns.indexOf('id')]).toBe('row-uuid');
    expect(values[columns.indexOf('resend_id')]).toBe('sent-id');
    expect(values[columns.indexOf('thread_id')]).toBe('<message-uuid@q3ik.com>');
    expect(values[columns.indexOf('from_address')]).toBe('mail@q3ik.com');
    expect(values[columns.indexOf('from_name')]).toBe('q3ik Mail');
    expect(values[columns.indexOf('to_address')]).toBe('a@b.com');
    expect(values[columns.indexOf('subject')]).toBe('Hi');
    expect(values[columns.indexOf('body_text')]).toBe('Hello');
    expect(values[columns.indexOf('body_html')]).toBeNull();
    expect(values[columns.indexOf('message_id')]).toBe('<message-uuid@q3ik.com>');
    expect(values[columns.indexOf('in_reply_to')]).toBeNull();
    expect(values[columns.indexOf('references')]).toBeNull();
    expect(values[columns.indexOf('is_read')]).toBe(1);
    expect(values[columns.indexOf('is_sent')]).toBe(1);
    expect(values[columns.indexOf('needs_rethreading')]).toBe(0);
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

  it('sets In-Reply-To and References headers when replyToId is provided', async () => {
    const MockedResend = Resend as MockedClass<typeof Resend>;
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('reply-message-uuid')
      .mockReturnValueOnce('reply-row-uuid');
    routeMocks.selectFirst.mockResolvedValueOnce({ thread_id: 'thread-123' });
    const sendSpy = vi.fn().mockResolvedValue({ data: { id: 'r1' }, error: null });
    MockedResend.mockImplementationOnce(() => ({ emails: { send: sendSpy } }) as unknown as Resend);
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

    const { columns, values } = getInsertArgs();
    expect(values[columns.indexOf('id')]).toBe('reply-row-uuid');
    expect(values[columns.indexOf('thread_id')]).toBe('thread-123');
    expect(values[columns.indexOf('message_id')]).toBe('<reply-message-uuid@q3ik.com>');
    expect(values[columns.indexOf('in_reply_to')]).toBe('<msg-1@example.com>');
    expect(values[columns.indexOf('references')]).toBe('<root@example.com> <msg-1@example.com>');
    expect(values[columns.indexOf('needs_rethreading')]).toBe(0);
  });

  it('still returns 200 when D1 persistence fails after send succeeds', async () => {
    routeMocks.insertRun.mockRejectedValueOnce(new Error('db unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
  });
});
