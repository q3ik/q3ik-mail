import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const getThreadListPage = vi.fn();

vi.mock('@cloudflare/next-on-pages', () => ({
  getRequestContext: () => ({
    env: { DB: {} },
  }),
}));

vi.mock('@q3ik-mail/database', () => ({
  getThreadListPage,
}));

describe('GET /api/emails', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns paginated threads on success', async () => {
    getThreadListPage.mockResolvedValue({
      threads: [{ id: '1', thread_id: 'thread-1' }],
      nextCursor: 'cursor-token',
    });

    const { GET } = await import('../route');
    const req = new Request('http://localhost/api/emails?limit=25&cursor=abc', {
      method: 'GET',
    });
    const res = await GET(req as unknown as NextRequest);

    expect(res.status).toBe(200);
    expect(getThreadListPage).toHaveBeenCalledWith({}, { limit: 25, cursor: 'abc' });
    await expect(res.json()).resolves.toEqual({
      threads: [{ id: '1', thread_id: 'thread-1' }],
      nextCursor: 'cursor-token',
    });
  });

  it('returns a structured 500 response when loading fails', async () => {
    getThreadListPage.mockRejectedValue(new Error('D1 exploded'));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('../route');
    const req = new Request('http://localhost/api/emails', {
      method: 'GET',
    });
    const res = await GET(req as unknown as NextRequest);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'Failed to load emails',
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
