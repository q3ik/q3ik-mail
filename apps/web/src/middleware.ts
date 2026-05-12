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
 * 4. Ensure the Pages deployment sits behind that Access Application before
 *    exposing it on a public domain.
 */

const PUBLIC_PATHS = new Set(['/api/webhook', '/favicon.ico']);
const PUBLIC_PREFIXES = ['/_next/static/', '/_next/image/'];

let cachedTeamDomain: string | undefined;
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function getAccessConfig():
  | { audience: string; issuer: string; loginUrl: URL; teamDomain: string }
  | null {
  const teamDomain = process.env.CLOUDFLARE_TEAM_DOMAIN;
  const audience = process.env.CLOUDFLARE_ACCESS_AUD;

  if (!teamDomain || !audience) {
    return null;
  }

  return {
    audience,
    issuer: `https://${teamDomain}`,
    loginUrl: new URL(`https://${teamDomain}`),
    teamDomain,
  };
}

function getJwks(teamDomain: string) {
  if (cachedJwks && cachedTeamDomain === teamDomain) {
    return cachedJwks;
  }

  cachedTeamDomain = teamDomain;
  cachedJwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
  return cachedJwks;
}

export async function middleware(req: NextRequest) {
  if (isPublicPath(req.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const accessConfig = getAccessConfig();

  if (!accessConfig) {
    return new NextResponse('Cloudflare Access is not configured', { status: 500 });
  }

  const token = req.headers.get('CF-Access-Jwt-Assertion');

  if (!token) {
    return NextResponse.redirect(accessConfig.loginUrl);
  }

  try {
    await jwtVerify(token, getJwks(accessConfig.teamDomain), {
      audience: accessConfig.audience,
      issuer: accessConfig.issuer,
    });

    return NextResponse.next();
  } catch {
    return NextResponse.redirect(accessConfig.loginUrl);
  }
}

export const config = {
  matcher: ['/((?!api/webhook|_next/static|_next/image|favicon.ico).*)'],
};
