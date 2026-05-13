import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { captureException, searchEmails, getRequestContext } = vi.hoisted(() => ({
  captureException: vi.fn().mockResolvedValue(undefined),
  searchEmails: vi.fn(),
  getRequestContext: vi.fn(),
}));

vi.mock('@cloudflare/next-on-pages', () => ({
  getRequestContext: () => getRequestContext(),
}));

vi.mock('@q3ik-mail/database', () => ({
  searchEmails,
}));

vi.mock('@/lib/sentry', () => ({
  captureException,
}));

describe('GET /api/search', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getRequestContext.mockReturnValue({ env: { DB: {} } });
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

  it('returns 400 when q is present but empty (?q=)', async () => {
    const { GET } = await import('../route');
    const req = new Request('http://localhost/api/search?q=', { method: 'GET' });
    const res = await GET(req as unknown as NextRequest);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'q is required' });
    expect(searchEmails).not.toHaveBeenCalled();
  });

  it('returns a structured 500 response when search fails', async () => {
    const dbError = new Error('D1 exploded');
    searchEmails.mockRejectedValue(dbError);

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
    expect(captureException).toHaveBeenCalledWith(dbError);
    errorSpy.mockRestore();
  });

  it('returns a structured 500 response when DB binding is missing', async () => {
    getRequestContext.mockReturnValue({ env: {} });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('../route');
    const req = new Request('http://localhost/api/search?q=hello', {
      method: 'GET',
    });
    const res = await GET(req);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'Failed to search emails',
    });
    expect(errorSpy).toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Database binding (DB) is missing' }),
    );
    errorSpy.mockRestore();
  });

  it('returns a structured 500 response when getRequestContext fails', async () => {
    const contextError = new Error('Context failure');
    getRequestContext.mockImplementation(() => {
      throw contextError;
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('../route');
    const req = new Request('http://localhost/api/search?q=hello', {
      method: 'GET',
    });
    const res = await GET(req);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: 'Failed to search emails',
    });
    expect(errorSpy).toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(contextError);
    errorSpy.mockRestore();
  });
});
