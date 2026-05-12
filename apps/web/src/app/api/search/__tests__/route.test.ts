import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const searchEmails = vi.fn();

vi.mock('@cloudflare/next-on-pages', () => ({
  getRequestContext: () => ({
    env: { DB: {} },
  }),
}));

vi.mock('@q3ik-mail/database', () => ({
  searchEmails,
}));

describe('GET /api/search', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns search results on success', async () => {
    searchEmails.mockResolvedValue([{ id: '1', thread_id: 'thread-1' }]);

    const { GET } = await import('../route');
    const req = new Request('http://localhost/api/search?q=hello', {
      method: 'GET',
    });
    const res = await GET(req as unknown as NextRequest);

    expect(res.status).toBe(200);
    expect(searchEmails).toHaveBeenCalledWith({}, 'hello');
    await expect(res.json()).resolves.toEqual([{ id: '1', thread_id: 'thread-1' }]);
  });

  it('returns 400 when q is missing', async () => {
    const { GET } = await import('../route');
    const req = new Request('http://localhost/api/search', { method: 'GET' });
    const res = await GET(req as unknown as NextRequest);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'q is required' });
    expect(searchEmails).not.toHaveBeenCalled();
  });

  it('returns 400 when q is blank/whitespace-only', async () => {
    const { GET } = await import('../route');
    const req = new Request('http://localhost/api/search?q=   ', { method: 'GET' });
    const res = await GET(req as unknown as NextRequest);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'q is required' });
    expect(searchEmails).not.toHaveBeenCalled();
  });

  it('returns a structured 500 response when search fails', async () => {
    searchEmails.mockRejectedValue(new Error('D1 exploded'));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('../route');
    const req = new Request('http://localhost/api/search?q=hello', {
      method: 'GET',
    });
    const res = await GET(req as unknown as NextRequest);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'Failed to search emails',
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
