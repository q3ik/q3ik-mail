import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const getEmailById = vi.fn();
const markAsRead = vi.fn();
const captureException = vi.fn();

vi.mock('@cloudflare/next-on-pages', () => ({
  getRequestContext: () => ({
    env: { DB: {} },
  }),
}));

vi.mock('@q3ik-mail/database', () => ({
  getEmailById,
  markAsRead,
}));

vi.mock('@/lib/sentry', () => ({
  captureException,
}));

describe('GET /api/emails/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns email payload when email exists', async () => {
    getEmailById.mockResolvedValue({
      id: 'email-1',
      thread_id: 'thread-1',
      resend_id: 'resend-1',
      from_address: 'sender@example.com',
      from_name: 'Sender',
      to_address: 'me@example.com',
      subject: 'Hello',
      body_text: 'Hello text',
      body_html: '<p>Hello</p>',
      message_id: '<message-1>',
      in_reply_to: null,
      references: null,
      is_read: true,
      is_sent: false,
      needs_rethreading: false,
      created_at: '2024-01-01T00:00:00Z',
    });

    const { GET } = await import('../route');
    const res = await GET(new Request('http://localhost/api/emails/email-1') as unknown as NextRequest, {
      params: Promise.resolve({ id: 'email-1' }),
    });

    expect(res.status).toBe(200);
    expect(getEmailById).toHaveBeenCalledWith({}, 'email-1', null);
    await expect(res.json()).resolves.toEqual({
      id: 'email-1',
      thread_id: 'thread-1',
      resend_id: 'resend-1',
      from_address: 'sender@example.com',
      from_name: 'Sender',
      to_address: 'me@example.com',
      subject: 'Hello',
      body_text: 'Hello text',
      body_html: '<p>Hello</p>',
      message_id: '<message-1>',
      in_reply_to: null,
      references: null,
      is_read: true,
      is_sent: false,
      created_at: '2024-01-01T00:00:00Z',
    });
  });

  it('marks unread email as read as a best-effort side-effect', async () => {
    getEmailById.mockResolvedValue({
      id: 'email-1',
      subject: 'Hello',
      is_read: false,
    });
    markAsRead.mockResolvedValue(undefined);

    const { GET } = await import('../route');
    const res = await GET(new Request('http://localhost/api/emails/email-1') as unknown as NextRequest, {
      params: Promise.resolve({ id: 'email-1' }),
    });

    expect(res.status).toBe(200);
    expect(markAsRead).toHaveBeenCalledWith({}, 'email-1');
  });

  it('handles markAsRead failure gracefully', async () => {
    getEmailById.mockResolvedValue({
      id: 'email-1',
      subject: 'Hello',
      is_read: false,
    });
    markAsRead.mockRejectedValue(new Error('D1 write failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { GET } = await import('../route');
    const res = await GET(new Request('http://localhost/api/emails/email-1') as unknown as NextRequest, {
      params: Promise.resolve({ id: 'email-1' }),
    });

    expect(res.status).toBe(200); // Should still return 200
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('returns 404 when email does not exist', async () => {
    getEmailById.mockResolvedValue(null);

    const { GET } = await import('../route');
    const res = await GET(new Request('http://localhost/api/emails/missing') as unknown as NextRequest, {
      params: Promise.resolve({ id: 'missing' }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Not found' });
  });

  it('returns a structured 500 response when loading fails', async () => {
    const error = new Error('D1 exploded');
    getEmailById.mockRejectedValue(error);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { GET } = await import('../route');
    const res = await GET(new Request('http://localhost/api/emails/email-1') as unknown as NextRequest, {
      params: Promise.resolve({ id: 'email-1' }),
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Failed to load email' });
    expect(captureException).toHaveBeenCalledWith(error);
    expect(errorSpy).toHaveBeenCalledWith('[api/emails/[id]] failed to load email:', error);
    errorSpy.mockRestore();
  });
});
