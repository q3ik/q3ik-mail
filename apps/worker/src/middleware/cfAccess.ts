/**
 * Cloudflare Access JWT validation middleware.
 *
 * Validates the `Cf-Access-Jwt-Assertion` header that Cloudflare Access
 * injects on every authenticated request. Rejects requests that are missing
 * the header, have an invalid signature, or carry the wrong AUD or ISS claim.
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
  nbf?: number;
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
 *
 * Wrapped in try/catch: any failure (network, malformed JWKS, importKey
 * rejection) returns null so the caller emits a controlled 401 rather than
 * an unhandled 500.
 */
async function getPublicKey(
  teamDomain: string,
  kid: string,
): Promise<CryptoKey | null> {
  try {
    const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
    const res = await fetch(certsUrl);
    if (!res.ok) return null;

    const jwks = await res.json<{ keys: Array<{ kid: string } & JsonWebKey> }>();
    const jwk = jwks.keys.find((k) => k.kid === kid);
    if (!jwk) return null;

    // `await` is required here inside the try/catch so that importKey
    // rejections are caught locally rather than escaping as unhandled.
    return await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch {
    return null;
  }
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
 * Validates the CF Access JWT from the `Cf-Access-Jwt-Assertion` header.
 *
 * Steps:
 *  1. Extract and structurally validate the JWT (3-part, base64url)
 *  2. Verify the AUD claim matches the configured Access AUD tag
 *  3. Verify the ISS claim matches `https://<CLOUDFLARE_TEAM_DOMAIN>`
 *  4. Verify exp (not expired) and nbf (not-before) with 60s clock-drift leeway
 *  5. Fetch the matching public key from the JWKS endpoint by `kid`
 *  6. Verify the RS256 signature
 */
export async function validateCfAccessJwt(
  request: Request,
  env: CfAccessEnv,
): Promise<ValidateResult> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) {
    return { ok: false, error: 'Missing Cf-Access-Jwt-Assertion header' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, error: 'Malformed JWT' };
  }

  const [rawHeader, rawPayload, rawSignature] = parts;

  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlDecode(rawHeader)));
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(rawPayload)));
    if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') {
      throw new Error();
    }
  } catch {
    return { ok: false, error: 'Failed to decode JWT parts' };
  }

  // Verify AUD and ISS claims.
  // ISS check prevents token substitution from other Cloudflare Access teams
  // that share the same AUD format but were issued by a different team domain.
  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(env.CLOUDFLARE_ACCESS_AUD)) {
    return { ok: false, error: 'JWT AUD mismatch' };
  }
  if (payload.iss !== `https://${env.CLOUDFLARE_TEAM_DOMAIN}`) {
    return { ok: false, error: 'JWT ISS mismatch' };
  }

  // Verify expiry and not-before claims with a 60s leeway to tolerate clock
  // drift between Cloudflare's token issuer and this Worker.
  const nowSec = Math.floor(Date.now() / 1000);
  const LEEWAY = 60;
  if (payload.exp + LEEWAY < nowSec) {
    return { ok: false, error: 'JWT expired' };
  }
  if (payload.nbf !== undefined && payload.nbf - LEEWAY > nowSec) {
    return { ok: false, error: 'JWT not yet valid' };
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

  // Decode the signature safely — a malformed base64url signature should
  // produce a controlled 401, not an unhandled Worker exception.
  let signature: Uint8Array;
  try {
    signature = base64urlDecode(rawSignature);
  } catch {
    return { ok: false, error: 'Invalid JWT signature encoding' };
  }

  // Verify RS256 signature
  const signingInput = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);

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
