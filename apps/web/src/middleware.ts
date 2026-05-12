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
let cachedConfig: AccessConfig | null | undefined;
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let cachedJwksTeamDomain: string | undefined;

/**
 * Security headers attached to every authenticated NextResponse.next().
 *
 * Content-Security-Policy is set via next.config.js headers() for the full
 * Next.js response pipeline. The subset below is mirrored here so that
 * middleware-generated responses — which bypass the next.config pipeline on
 * some Cloudflare Pages deployments — also carry the headers.
 *
 * X-Frame-Options and X-Content-Type-Options are intentionally kept here
 * rather than relying solely on CSP `frame-ancestors` because some older
 * proxies and security scanners only recognise the legacy headers.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

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
 * Cloudflare Access delivers the JWT in two ways:
 * - As a `CF-Access-Jwt-Assertion` request header
 * - As a `CF_Authorization` cookie (primary for browser sessions)
 *
 * The header is checked first; the cookie is the fallback.
 */
function resolveAccessToken(req: NextRequest): string | null {
  return (
    req.headers.get('CF-Access-Jwt-Assertion') ??
    req.cookies.get(CF_ACCESS_COOKIE)?.value ??
    null
  );
}

/** Returns NextResponse.next() with all security headers attached. */
function nextWithSecurityHeaders(): NextResponse {
  const res = NextResponse.next();
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(key, value);
  }
  return res;
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
    return nextWithSecurityHeaders();
  } catch (error) {
    console.error('[middleware] JWT verification failed:', error);
    return NextResponse.redirect(accessConfig.loginUrl);
  }
}

export const config = {
  matcher: ['/((?!api/webhook|_next/static|_next/image|favicon.ico).*)'],
};
