import { describe, it, expect, vi } from 'vitest';
import { validateCfAccessJwt, type CfAccessEnv } from './cfAccess';

const mockEnv: CfAccessEnv = {
  CLOUDFLARE_ACCESS_AUD: 'test-aud-value',
  CLOUDFLARE_TEAM_DOMAIN: 'test-team.cloudflareaccess.com',
};

// Minimal base64url encoder for building test JWTs
function base64url(obj: unknown): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function makeRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers['CF_Access_Jwt_Assertion'] = token;
  }
  return new Request('https://worker.example.com/', { method: 'POST', headers });
}

describe('validateCfAccessJwt', () => {
  it('rejects requests missing the header', async () => {
    const result = await validateCfAccessJwt(makeRequest(), mockEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Missing/);
  });

  it('rejects malformed JWT (wrong number of parts)', async () => {
    const result = await validateCfAccessJwt(makeRequest('not.a.valid.jwt.parts'), mockEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Malformed/);
  });

  it('rejects JWT with wrong AUD', async () => {
    const header = base64url({ alg: 'RS256', kid: 'kid1' });
    const payload = base64url({
      aud: 'wrong-aud',
      iss: 'https://test-team.cloudflareaccess.com',
      sub: 'user@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await validateCfAccessJwt(makeRequest(`${header}.${payload}.fakesig`), mockEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/AUD mismatch/);
  });

  it('rejects JWT with wrong ISS', async () => {
    const header = base64url({ alg: 'RS256', kid: 'kid1' });
    const payload = base64url({
      aud: 'test-aud-value',
      iss: 'https://evil-other-team.cloudflareaccess.com',
      sub: 'user@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await validateCfAccessJwt(makeRequest(`${header}.${payload}.fakesig`), mockEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ISS mismatch/);
  });

  it('rejects an expired JWT', async () => {
    const header = base64url({ alg: 'RS256', kid: 'kid1' });
    const payload = base64url({
      aud: 'test-aud-value',
      iss: 'https://test-team.cloudflareaccess.com',
      sub: 'user@example.com',
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600, // expired
    });
    const result = await validateCfAccessJwt(makeRequest(`${header}.${payload}.fakesig`), mockEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/expired/);
  });

  it('rejects unsupported algorithm', async () => {
    const header = base64url({ alg: 'HS256', kid: 'kid1' });
    const payload = base64url({
      aud: 'test-aud-value',
      iss: 'https://test-team.cloudflareaccess.com',
      sub: 'user@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await validateCfAccessJwt(makeRequest(`${header}.${payload}.fakesig`), mockEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Unsupported algorithm/);
  });

  it('rejects when JWKS endpoint returns unknown kid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [{ kid: 'other-kid', kty: 'RSA' }] }),
    }));

    const header = base64url({ alg: 'RS256', kid: 'kid1' });
    const payload = base64url({
      aud: 'test-aud-value',
      iss: 'https://test-team.cloudflareaccess.com',
      sub: 'user@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await validateCfAccessJwt(makeRequest(`${header}.${payload}.fakesig`), mockEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Public key not found/);

    vi.unstubAllGlobals();
  });

  it('returns controlled error when JWKS fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));

    const header = base64url({ alg: 'RS256', kid: 'kid1' });
    const payload = base64url({
      aud: 'test-aud-value',
      iss: 'https://test-team.cloudflareaccess.com',
      sub: 'user@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await validateCfAccessJwt(makeRequest(`${header}.${payload}.fakesig`), mockEnv);
    expect(result.ok).toBe(false);
    // Should be a controlled 401 message, not an unhandled throw
    if (!result.ok) expect(result.error).toMatch(/Public key not found/);

    vi.unstubAllGlobals();
  });
});
