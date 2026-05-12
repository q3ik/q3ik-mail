import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const joseMocks = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn(),
  remoteJwkSet: Symbol('remoteJwkSet'),
}));

vi.mock('jose/jwks/remote', () => ({
  createRemoteJWKSet: joseMocks.createRemoteJWKSet,
}));

vi.mock('jose/jwt/verify', () => ({
  jwtVerify: joseMocks.jwtVerify,
}));

describe('Cloudflare Access middleware', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    joseMocks.createRemoteJWKSet.mockReturnValue(joseMocks.remoteJwkSet);
    joseMocks.jwtVerify.mockResolvedValue({ payload: {} });
    process.env.CLOUDFLARE_TEAM_DOMAIN = 'team.example.cloudflareaccess.com';
    process.env.CLOUDFLARE_ACCESS_AUD = 'test-audience';
  });

  it('allows requests with a valid Cloudflare Access JWT', async () => {
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/inbox', {
      headers: {
        'CF-Access-Jwt-Assertion': 'valid-token',
      },
    });

    const res = await middleware(req);

    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(joseMocks.createRemoteJWKSet).toHaveBeenCalledWith(
      new URL('https://team.example.cloudflareaccess.com/cdn-cgi/access/certs'),
    );
    expect(joseMocks.jwtVerify).toHaveBeenCalledWith('valid-token', joseMocks.remoteJwkSet, {
      audience: 'test-audience',
      issuer: 'https://team.example.cloudflareaccess.com',
    });
  });

  it('redirects requests without a Cloudflare Access JWT', async () => {
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/inbox');

    const res = await middleware(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://team.example.cloudflareaccess.com/');
    expect(joseMocks.jwtVerify).not.toHaveBeenCalled();
  });

  it('redirects requests with an invalid JWT', async () => {
    joseMocks.jwtVerify.mockRejectedValueOnce(new Error('signature verification failed'));
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/inbox', {
      headers: {
        'CF-Access-Jwt-Assertion': 'bad-token',
      },
    });

    const res = await middleware(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://team.example.cloudflareaccess.com/');
  });

  it('redirects requests with an expired JWT', async () => {
    const expiredError = Object.assign(new Error('token expired'), { name: 'JWTExpired' });
    joseMocks.jwtVerify.mockRejectedValueOnce(expiredError);
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/inbox', {
      headers: {
        'CF-Access-Jwt-Assertion': 'expired-token',
      },
    });

    const res = await middleware(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://team.example.cloudflareaccess.com/');
  });

  it('bypasses the guard for the inbound webhook path', async () => {
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/api/webhook');

    const res = await middleware(req);

    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(joseMocks.jwtVerify).not.toHaveBeenCalled();
  });

  it('uses a matcher that excludes the webhook and Next.js internals', async () => {
    const { config } = await import('../middleware');

    expect(config.matcher).toEqual(['/((?!api/webhook|_next/static|_next/image|favicon.ico).*)']);
  });
});
