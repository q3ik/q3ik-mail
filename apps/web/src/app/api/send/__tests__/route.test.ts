import { describe, it, expect, vi, type MockedClass } from 'vitest';
import type { NextRequest } from 'next/server';
import { Resend } from 'resend';
import type { CreateEmailOptions } from 'resend';

// Mock @cloudflare/next-on-pages before importing the route
vi.mock('@cloudflare/next-on-pages', () => ({
  getRequestContext: () => ({
    env: { RESEND_API_KEY: 'test-key' },
  }),
}));

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: {
      send: vi.fn().mockResolvedValue({ data: { id: 'sent-id' }, error: null }),
    },
  })),
}));

describe('POST /api/send', () => {
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

  it('returns 200 with email id on success', async () => {
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
    const sendSpy = vi.fn().mockResolvedValue({ data: { id: 'r1' }, error: null });
    MockedResend.mockImplementationOnce(() => ({ emails: { send: sendSpy } }) as unknown as Resend);
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/send', {
      method: 'POST',
      body: JSON.stringify({ to: 'a@b.com', subject: 'Re: Hi', content: 'Hi back', replyToId: '<msg-1@example.com>' }),
      headers: { 'Content-Type': 'application/json' },
    });
    await POST(req as unknown as NextRequest);
    const callArgs = sendSpy.mock.calls[0][0] as CreateEmailOptions;
    expect(callArgs.headers?.['In-Reply-To']).toBe('<msg-1@example.com>');
    expect(callArgs.headers?.['References']).toBe('<msg-1@example.com>');
  });
});
