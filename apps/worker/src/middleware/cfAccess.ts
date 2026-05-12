/**
 * Cloudflare Access JWT validation middleware.
 *
 * Validates the `CF_Access_Jwt_Assertion` header that Cloudflare Access
 * injects on every authenticated request. Rejects requests that are missing
 * the header, have an invalid signature, or carry the wrong AUD claim.
 *
 * References:
 *   https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 *
 * Usage (in index.ts fetch handler, BEFORE any business logic):
 *
 *   import { validateCfAccessJwt } from './middleware/cfAccess';
 *
 *   const accessResult = await validateCfAccessJwt(request, env);
 *   if (!accessResult.ok) {
 *     return new Response(accessResult.error, { status: 401 });
 *   }
 *   // accessResult.payload contains the verified JWT claims
 */

export interface CfAccessEnv {
  /** AUD tag from the Cloudflare Access application. Set via `wrangler secret put`. */
  CLOUDFLARE_ACCESS_AUD: string;
  /** Your Zero Trust team domain, e.g. "your-team.cloudflareaccess.com" */
  CLOUDFLARE_TEAM_DOMAIN: string;
}

interface JwtHeader {
  alg: string;
  kid: string;
}

interface JwtPayload {
  aud: string | string[];
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  email?: string;
  [key: string]: unknown;
}

type ValidateResult =
  | { ok: true; payload: JwtPayload }
  | { ok: false; error: string };

/**
 * Fetches the JWKS from the Cloudflare Access certs endpoint and returns the
 * CryptoKey matching the given `kid`. Results are NOT cached here — the
 * Workers runtime automatically caches `fetch()` responses respecting
 * Cache-Control headers returned by the CF certs endpoint (24h TTL).
 */
async function getPublicKey(
  teamDomain: string,
  kid: string,
): Promise<CryptoKey | null> {
  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(certsUrl);
  if (!res.ok) return null;

  const jwks = await res.json<{ keys: Array<{ kid: string } & JsonWebKey> }>();
  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk) return null;

  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

/**
 * Decodes a base64url string to a Uint8Array without any external dependencies.
 */
function base64urlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    input.length + ((4 - (input.length % 4)) % 4),
    '=',
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Validates the CF Access JWT from the `CF_Access_Jwt_Assertion` header.
 *
 * Steps:
 *  1. Extract and structurally validate the JWT (3-part, base64url)
 *  2. Verify the AUD claim matches the configured Access AUD tag
 *  3. Verify the exp claim (not expired)
 *  4. Fetch the matching public key from the JWKS endpoint by `kid`
 *  5. Verify the RS256 signature
 */
export async function validateCfAccessJwt(
  request: Request,
  env: CfAccessEnv,
): Promise<ValidateResult> {
  const token = request.headers.get('CF_Access_Jwt_Assertion');
  if (!token) {
    return { ok: false, error: 'Missing CF_Access_Jwt_Assertion header' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, error: 'Malformed JWT' };
  }

  const [rawHeader, rawPayload, rawSignature] = parts;

  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlDecode(rawHeader))) as JwtHeader;
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(rawPayload))) as JwtPayload;
  } catch {
    return { ok: false, error: 'Failed to decode JWT parts' };
  }

  // Verify AUD claim
  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(env.CLOUDFLARE_ACCESS_AUD)) {
    return { ok: false, error: 'JWT AUD mismatch' };
  }

  // Verify expiry (use seconds, same as JWT spec)
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp < nowSec) {
    return { ok: false, error: 'JWT expired' };
  }

  // Only RS256 is supported by CF Access
  if (header.alg !== 'RS256') {
    return { ok: false, error: `Unsupported algorithm: ${header.alg}` };
  }

  // Fetch the signing public key
  const publicKey = await getPublicKey(env.CLOUDFLARE_TEAM_DOMAIN, header.kid);
  if (!publicKey) {
    return { ok: false, error: 'Public key not found for kid' };
  }

  // Verify RS256 signature
  const signingInput = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
  const signature = base64urlDecode(rawSignature);

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    signature,
    signingInput,
  );

  if (!valid) {
    return { ok: false, error: 'JWT signature verification failed' };
  }

  return { ok: true, payload };
}
