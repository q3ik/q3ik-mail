import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const getThreadListPage = vi.fn();

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({
    env: { DB: {}, THREAD_LIST_CURSOR_SECRET: 'cursor-secret' },
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
    expect(getThreadListPage).toHaveBeenCalledWith({}, { limit: 25, cursor: 'abc', cursorSecret: 'cursor-secret' });
    await expect(res.json()).resolves.toEqual({
      threads: [{ id: '1', thread_id: 'thread-1' }],
      nextCursor: 'cursor-token',
    });
  });

  it('uses default values when parameters are missing', async () => {
    getThreadListPage.mockResolvedValue({
      threads: [],
      nextCursor: null,
    });

    const { GET } = await import('../route');
    const req = new Request('http://localhost/api/emails', {
      method: 'GET',
    });
    const res = await GET(req as unknown as NextRequest);

    expect(res.status).toBe(200);
    // DEFAULT_LIMIT is 50, cursor should be undefined
    expect(getThreadListPage).toHaveBeenCalledWith({}, { limit: 50, cursor: undefined, cursorSecret: 'cursor-secret' });
  });

  it('handles invalid limit values by falling back to default', async () => {
    getThreadListPage.mockResolvedValue({ threads: [] });

    const { GET } = await import('../route');

    // Non-numeric limit
    const req1 = new Request('http://localhost/api/emails?limit=invalid');
    await GET(req1 as unknown as NextRequest);
    expect(getThreadListPage).toHaveBeenLastCalledWith({}, { limit: 50, cursor: undefined, cursorSecret: 'cursor-secret' });

    // Negative limit
    const req2 = new Request('http://localhost/api/emails?limit=-10');
    await GET(req2 as unknown as NextRequest);
    expect(getThreadListPage).toHaveBeenLastCalledWith({}, { limit: 50, cursor: undefined, cursorSecret: 'cursor-secret' });
  });

  it('caps the limit to MAX_LIMIT', async () => {
    getThreadListPage.mockResolvedValue({ threads: [] });

    const { GET } = await import('../route');
    const req = new Request('http://localhost/api/emails?limit=1000');
    await GET(req as unknown as NextRequest);

    // MAX_LIMIT is 100
    expect(getThreadListPage).toHaveBeenCalledWith({}, { limit: 100, cursor: undefined, cursorSecret: 'cursor-secret' });
  });

  it('returns a structured 500 response when loading fails', async () => {
    const error = new Error('D1 exploded');
    getThreadListPage.mockRejectedValue(error);

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
    expect(errorSpy).toHaveBeenCalledWith('[api/emails] failed to load emails:', error);
    errorSpy.mockRestore();
  });
});
