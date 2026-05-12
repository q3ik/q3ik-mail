import { createRemoteJWKSet } from 'jose/jwks/remote';
import { jwtVerify } from 'jose/jwt/verify';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Cloudflare Access setup:
 * 1. In the Cloudflare Zero Trust dashboard, create an Access Application for
 *    this Pages deployment and attach the desired single-user identity policy.
 * 2. Copy the team domain (for example, `your-team.cloudflareaccess.com`) into
 *    `CLOUDFLARE_TEAM_DOMAIN`.
 * 3. Copy the Access Application Audience tag into
 *    `CLOUDFLARE_ACCESS_AUD`.
 * 4. In the Access Application → Additional Settings → Cookie settings:
 *    - Enable **HTTP Only** to prevent client-side JS from reading the JWT cookie.
 *    - Enable **Binding Cookie** to bind the session to the user's TLS session,
 *      protecting against token theft. Safe for web apps (not SSH/RDP).
 * 5. Ensure the Pages deployment sits behind that Access Application before
 *    exposing it on a public domain.
 */

// /favicon.ico is excluded by the matcher pattern below; it does not need a
// runtime check inside isPublicPath().
const PUBLIC_PATHS = ['/api/webhook'] as const;
const PUBLIC_PREFIXES = ['/_next/static/', '/_next/image/'] as const;
const PUBLIC_PATH_SET = new Set<string>(PUBLIC_PATHS);
const TEAM_DOMAIN_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.cloudflareaccess\.com$/;

/**
 * Name of the HttpOnly cookie Cloudflare Access sets when "Binding Cookie" is
 * enabled in the Access Application cookie settings. The middleware checks this
 * as a fallback when the CF-Access-Jwt-Assertion header is absent — which is
 * normal for direct browser navigations when HTTP Only is enabled.
 */
const CF_ACCESS_COOKIE = 'CF_Authorization';

type AccessConfig = {
  audience: string;
  issuer: string;
  loginUrl: URL;
  teamDomain: string;
};

// Module-level caches — valid for the lifetime of the edge worker instance.
// cachedConfig uses `undefined` as a sentinel meaning "not yet evaluated" so
// that a legitimate `null` (bad config) is also cached and not re-evaluated
// on every request.
let cachedConfig: AccessConfig | null | undefined;
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let cachedJwksTeamDomain: string | undefined;

function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PATH_SET.has(pathname) ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

/**
 * Reads and validates env vars, caching the result for the worker lifetime.
 * Returns null (and caches it) if either var is absent, the audience is
 * whitespace-only, or the team domain fails the allowlist pattern.
 *
 * Both vars are trimmed so stray whitespace in the deployment env does not
 * silently break JWT verification.
 */
function getAccessConfig(): AccessConfig | null {
  if (cachedConfig !== undefined) {
    return cachedConfig;
  }

  const rawTeamDomain = process.env.CLOUDFLARE_TEAM_DOMAIN;
  const rawAudience = process.env.CLOUDFLARE_ACCESS_AUD;

  if (!rawTeamDomain || !rawAudience) {
    cachedConfig = null;
    return null;
  }

  const teamDomain = rawTeamDomain.trim().toLowerCase();
  const audience = rawAudience.trim();

  if (!audience || !TEAM_DOMAIN_PATTERN.test(teamDomain)) {
    cachedConfig = null;
    return null;
  }

  cachedConfig = {
    audience,
    issuer: `https://${teamDomain}`,
    loginUrl: new URL(`https://${teamDomain}`),
    teamDomain,
  };
  return cachedConfig;
}

function getJwks(teamDomain: string) {
  if (cachedJwks && cachedJwksTeamDomain === teamDomain) {
    return cachedJwks;
  }
  cachedJwksTeamDomain = teamDomain;
  cachedJwks = createRemoteJWKSet(
    new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
  );
  return cachedJwks;
}

/**
 * Resolves the Cloudflare Access JWT from the incoming request.
 *
 * Cloudflare Access delivers the JWT in two ways depending on the Access
 * Application cookie settings:
 *
 * - As a `CF-Access-Jwt-Assertion` request **header** — present on all
 *   requests proxied through Access, including API calls and service tokens.
 * - As a `CF_Authorization` **cookie** — the primary delivery mechanism for
 *   browser sessions when "Binding Cookie" is enabled (recommended). With
 *   HTTP Only also enabled, client-side JS cannot read this cookie.
 *
 * The header is checked first; the cookie is the fallback. Either is
 * sufficient for JWT verification — both contain the same signed token.
 */
function resolveAccessToken(req: NextRequest): string | null {
  return (
    req.headers.get('CF-Access-Jwt-Assertion') ??
    req.cookies.get(CF_ACCESS_COOKIE)?.value ??
    null
  );
}

export async function middleware(req: NextRequest) {
  if (isPublicPath(req.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const accessConfig = getAccessConfig();

  if (!accessConfig) {
    console.error(
      '[middleware] Missing or invalid CLOUDFLARE_TEAM_DOMAIN or CLOUDFLARE_ACCESS_AUD',
    );
    return new NextResponse('Internal Server Error', { status: 500 });
  }

  const token = resolveAccessToken(req);

  if (!token) {
    return NextResponse.redirect(accessConfig.loginUrl);
  }

  try {
    await jwtVerify(token, getJwks(accessConfig.teamDomain), {
      audience: accessConfig.audience,
      issuer: accessConfig.issuer,
    });
    return NextResponse.next();
  } catch (error) {
    // Log the specific jose error to aid debugging (expired token, bad
    // signature, JWKS fetch failure, audience/issuer mismatch, etc.)
    // without leaking the token value itself.
    console.error('[middleware] JWT verification failed:', error);
    return NextResponse.redirect(accessConfig.loginUrl);
  }
}

export const config = {
  // Next.js requires middleware matchers to stay statically analyzable.
  // favicon.ico is excluded here via the negative lookahead.
  // /api/webhook is excluded both here and via isPublicPath() for defence-in-depth.
  // Keep this literal in sync with PUBLIC_PATHS and PUBLIC_PREFIXES above.
  matcher: ['/((?!api/webhook|_next/static|_next/image|favicon.ico).*)'],
};
