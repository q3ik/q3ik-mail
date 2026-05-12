import { describe, it, expect, vi, beforeEach } from 'vitest';

const getEmailById = vi.fn();

vi.mock('@cloudflare/next-on-pages', () => ({
  getRequestContext: () => ({
    env: { DB: {} },
  }),
}));

vi.mock('@q3ik-mail/database', () => ({
  getEmailById,
}));

describe('GET /api/emails/[id]/body', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns body payload when email exists', async () => {
    getEmailById.mockResolvedValue({
      id: 'email-1',
      body_html: '<p>Hello</p>',
      body_text: 'Hello',
    });

    const { GET } = await import('../route');
    const res = await GET(new Request('http://localhost/api/emails/email-1/body'), {
      params: Promise.resolve({ id: 'email-1' }),
    });

    expect(res.status).toBe(200);
    expect(getEmailById).toHaveBeenCalledWith({}, 'email-1', null);
    await expect(res.json()).resolves.toEqual({
      body_html: '<p>Hello</p>',
      body_text: 'Hello',
    });
  });

  it('returns 404 when email does not exist', async () => {
    getEmailById.mockResolvedValue(null);

    const { GET } = await import('../route');
    const res = await GET(new Request('http://localhost/api/emails/missing/body'), {
      params: Promise.resolve({ id: 'missing' }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Not found' });
  });
});
