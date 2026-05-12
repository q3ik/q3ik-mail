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
    // vi.resetModules() re-evaluates the middleware module on next import,
    // which resets cachedConfig / cachedJwks / cachedJwksTeamDomain between
    // tests so each test starts from a clean module-level state.
    vi.resetModules();
    vi.clearAllMocks();
    joseMocks.createRemoteJWKSet.mockReturnValue(joseMocks.remoteJwkSet);
    joseMocks.jwtVerify.mockResolvedValue({ payload: {} });
    process.env.CLOUDFLARE_TEAM_DOMAIN = 'team.example.cloudflareaccess.com';
    process.env.CLOUDFLARE_ACCESS_AUD = 'test-audience';
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it('allows requests with a valid Cloudflare Access JWT', async () => {
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/inbox', {
      headers: { 'CF-Access-Jwt-Assertion': 'valid-token' },
    });

    const res = await middleware(req);

    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(joseMocks.createRemoteJWKSet).toHaveBeenCalledWith(
      new URL('https://team.example.cloudflareaccess.com/cdn-cgi/access/certs'),
    );
    expect(joseMocks.jwtVerify).toHaveBeenCalledWith(
      'valid-token',
      joseMocks.remoteJwkSet,
      {
        audience: 'test-audience',
        issuer: 'https://team.example.cloudflareaccess.com',
      },
    );
  });

  it('caches the JWKS instance — createRemoteJWKSet called only once across multiple requests', async () => {
    const { middleware } = await import('../middleware');
    const makeReq = () =>
      new NextRequest('http://localhost/inbox', {
        headers: { 'CF-Access-Jwt-Assertion': 'valid-token' },
      });

    await middleware(makeReq());
    await middleware(makeReq());

    expect(joseMocks.createRemoteJWKSet).toHaveBeenCalledTimes(1);
  });

  // ── Missing / invalid token ───────────────────────────────────────────────

  it('redirects requests without a Cloudflare Access JWT', async () => {
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/inbox');

    const res = await middleware(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'https://team.example.cloudflareaccess.com/',
    );
    expect(joseMocks.jwtVerify).not.toHaveBeenCalled();
  });

  it('redirects and logs when JWT verification fails (invalid signature)', async () => {
    const verifyError = new Error('signature verification failed');
    joseMocks.jwtVerify.mockRejectedValueOnce(verifyError);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { middleware } = await import('../middleware');
      const req = new NextRequest('http://localhost/inbox', {
        headers: { 'CF-Access-Jwt-Assertion': 'bad-token' },
      });

      const res = await middleware(req);

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'https://team.example.cloudflareaccess.com/',
      );
      expect(errorSpy).toHaveBeenCalledWith(
        '[middleware] JWT verification failed:',
        verifyError,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('redirects and logs when JWT is expired', async () => {
    const expiredError = Object.assign(new Error('token expired'), {
      name: 'JWTExpired',
    });
    joseMocks.jwtVerify.mockRejectedValueOnce(expiredError);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { middleware } = await import('../middleware');
      const req = new NextRequest('http://localhost/inbox', {
        headers: { 'CF-Access-Jwt-Assertion': 'expired-token' },
      });

      const res = await middleware(req);

      expect(res.status).toBe(307);
      expect(errorSpy).toHaveBeenCalledWith(
        '[middleware] JWT verification failed:',
        expiredError,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  // ── Invalid / missing config ─────────────────────────────────────────────

  it('fails closed (500) when CLOUDFLARE_TEAM_DOMAIN is an invalid value', async () => {
    process.env.CLOUDFLARE_TEAM_DOMAIN = 'https://attacker.example';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { middleware } = await import('../middleware');
      const req = new NextRequest('http://localhost/inbox');

      const res = await middleware(req);

      expect(res.status).toBe(500);
      expect(joseMocks.createRemoteJWKSet).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        '[middleware] Missing or invalid CLOUDFLARE_TEAM_DOMAIN or CLOUDFLARE_ACCESS_AUD',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('fails closed (500) when CLOUDFLARE_ACCESS_AUD is missing', async () => {
    delete process.env.CLOUDFLARE_ACCESS_AUD;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { middleware } = await import('../middleware');
      const req = new NextRequest('http://localhost/inbox');

      const res = await middleware(req);

      expect(res.status).toBe(500);
      expect(joseMocks.createRemoteJWKSet).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        '[middleware] Missing or invalid CLOUDFLARE_TEAM_DOMAIN or CLOUDFLARE_ACCESS_AUD',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('fails closed (500) when CLOUDFLARE_ACCESS_AUD is whitespace-only', async () => {
    process.env.CLOUDFLARE_ACCESS_AUD = '   ';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { middleware } = await import('../middleware');
      const req = new NextRequest('http://localhost/inbox');

      const res = await middleware(req);

      expect(res.status).toBe(500);
      expect(joseMocks.createRemoteJWKSet).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('trims whitespace from CLOUDFLARE_ACCESS_AUD before passing to jwtVerify', async () => {
    process.env.CLOUDFLARE_ACCESS_AUD = '  test-audience  ';
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/inbox', {
      headers: { 'CF-Access-Jwt-Assertion': 'valid-token' },
    });

    await middleware(req);

    expect(joseMocks.jwtVerify).toHaveBeenCalledWith(
      'valid-token',
      joseMocks.remoteJwkSet,
      expect.objectContaining({ audience: 'test-audience' }),
    );
  });

  // ── Public path bypass ───────────────────────────────────────────────────

  it('bypasses the guard for the inbound webhook path', async () => {
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/api/webhook');

    const res = await middleware(req);

    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(joseMocks.jwtVerify).not.toHaveBeenCalled();
  });

  it('uses a matcher that excludes the webhook and Next.js internals', async () => {
    const { config } = await import('../middleware');

    expect(config.matcher).toEqual([
      '/((?!api/webhook|_next/static|_next/image|favicon.ico).*)',
    ]);
  });
});
