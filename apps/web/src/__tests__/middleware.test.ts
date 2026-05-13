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

vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
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

  it('re-reads CLOUDFLARE_ACCESS_AUD and CLOUDFLARE_TEAM_DOMAIN across requests', async () => {
    const { middleware } = await import('../middleware');

    process.env.CLOUDFLARE_TEAM_DOMAIN = 'team-one.cloudflareaccess.com';
    process.env.CLOUDFLARE_ACCESS_AUD = 'aud-one';
    await middleware(
      new NextRequest('http://localhost/inbox', {
        headers: { 'CF-Access-Jwt-Assertion': 'valid-token' },
      }),
    );

    process.env.CLOUDFLARE_TEAM_DOMAIN = 'team-two.cloudflareaccess.com';
    process.env.CLOUDFLARE_ACCESS_AUD = 'aud-two';
    await middleware(
      new NextRequest('http://localhost/inbox', {
        headers: { 'CF-Access-Jwt-Assertion': 'valid-token' },
      }),
    );

    expect(joseMocks.createRemoteJWKSet).toHaveBeenNthCalledWith(
      1,
      new URL('https://team-one.cloudflareaccess.com/cdn-cgi/access/certs'),
    );
    expect(joseMocks.createRemoteJWKSet).toHaveBeenNthCalledWith(
      2,
      new URL('https://team-two.cloudflareaccess.com/cdn-cgi/access/certs'),
    );
    expect(joseMocks.jwtVerify).toHaveBeenNthCalledWith(
      2,
      'valid-token',
      joseMocks.remoteJwkSet,
      {
        audience: 'aud-two',
        issuer: 'https://team-two.cloudflareaccess.com',
      },
    );
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

  it('bypasses the guard for trigger-inbound', async () => {
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/api/trigger-inbound');

    const res = await middleware(req);

    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(joseMocks.jwtVerify).not.toHaveBeenCalled();
  });

  it('bypasses the guard for webhook with trailing slash', async () => {
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/api/webhook/');

    const res = await middleware(req);

    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(joseMocks.jwtVerify).not.toHaveBeenCalled();
  });

  it('uses a matcher that excludes Next.js internals', async () => {
    const { config } = await import('../middleware');

    expect(config.matcher).toEqual([
      '/((?!_next/static|_next/image|favicon.ico).*)',
    ]);
  });

  // ── Auth regression: protected API routes ────────────────────────────────

  it('redirects /api/emails/[id]/body when no JWT is present — middleware is the sole auth gate', async () => {
    // Regression guard: the route handler no longer has its own auth check.
    // This test proves that a request to the body endpoint without a valid
    // CF Access JWT is rejected at the middleware layer. If this test fails,
    // the endpoint is reachable without authentication.
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/api/emails/email-1/body');

    const res = await middleware(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'https://team.example.cloudflareaccess.com/',
    );
    expect(joseMocks.jwtVerify).not.toHaveBeenCalled();
  });

  it('redirects /api/emails/[id]/body when a syntactically valid but cryptographically invalid JWT is presented', async () => {
    // Regression guard: proves that a forged "a.b.c" token (which the old
    // hasAccessJwt() syntactic check would have accepted) is correctly
    // rejected by the cryptographic jwtVerify in middleware.
    const verifyError = new Error('signature verification failed');
    joseMocks.jwtVerify.mockRejectedValueOnce(verifyError);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { middleware } = await import('../middleware');
      const req = new NextRequest('http://localhost/api/emails/email-1/body', {
        headers: { 'CF-Access-Jwt-Assertion': 'a.b.c' },
      });

      const res = await middleware(req);

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        'https://team.example.cloudflareaccess.com/',
      );
      // jwtVerify WAS called — the token was not trivially accepted
      expect(joseMocks.jwtVerify).toHaveBeenCalledWith(
        'a.b.c',
        joseMocks.remoteJwkSet,
        expect.objectContaining({
          audience: 'test-audience',
          issuer: 'https://team.example.cloudflareaccess.com',
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  // ── Security headers ─────────────────────────────────────────────────────

  it('attaches X-Content-Type-Options: nosniff on authenticated responses', async () => {
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/inbox', {
      headers: { 'CF-Access-Jwt-Assertion': 'valid-token' },
    });

    const res = await middleware(req);

    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('attaches X-Frame-Options: DENY on authenticated responses', async () => {
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/inbox', {
      headers: { 'CF-Access-Jwt-Assertion': 'valid-token' },
    });

    const res = await middleware(req);

    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('attaches Referrer-Policy on authenticated responses', async () => {
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/inbox', {
      headers: { 'CF-Access-Jwt-Assertion': 'valid-token' },
    });

    const res = await middleware(req);

    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('does NOT attach security headers to the public webhook path', async () => {
    const { middleware } = await import('../middleware');
    const req = new NextRequest('http://localhost/api/webhook');

    const res = await middleware(req);

    // Webhook bypasses auth entirely — security headers must not be applied.
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBeNull();
  });
});
