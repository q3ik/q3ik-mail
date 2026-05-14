import { getRequestContext } from '@cloudflare/next-on-pages';
import { getEmailById } from '@q3ik-mail/database';
import { captureException, captureMessage } from '@/lib/sentry';

export const runtime = 'edge';

/** Validates that a string is a well-formed UUID v4 (lowercase hex + hyphens). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Validates the Cloudflare Access JWT from the CF-Access-Jwt-Assertion header.
 *
 * SECURITY NOTE: This performs structural validation only (3-part JWT format).
 * Full cryptographic verification is handled upstream by the Cloudflare Access
 * proxy which sits in front of this Pages deployment. This guard exists as a
 * defense-in-depth check to ensure the route is never served without the Access
 * layer active (e.g., if the domain is accidentally exposed without an Access
 * policy). It is NOT a substitute for cryptographic verification — if this
 * route is ever moved outside the CF Access proxy, replace this with full JWT
 * verification (see apps/worker/src/middleware/cfAccess.ts for reference).
 */
function hasAccessJwt(request: Request): boolean {
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!jwt) return false;
  // A valid JWT has exactly 3 base64url segments separated by dots.
  const parts = jwt.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Cloudflare Access injects cf-access-jwt-assertion on authenticated requests.
    // Reject any request missing this header — it means Access was bypassed or
    // the route is being hit directly without the Access policy in front of it.
    if (!hasAccessJwt(req)) {
      void captureMessage('[api/email-body] missing or malformed Cloudflare Access JWT', {
        level: 'warning',
        tags: { category: 'security-auth', surface: 'api.email-body', auth_provider: 'cloudflare-access' },
        extra: { path: new URL(req.url).pathname },
      });
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    if (!UUID_RE.test(id)) {
      return Response.json({ error: 'Invalid email ID format' }, { status: 400 });
    }

    const { env } = getRequestContext();

    const r2Bucket = 'EMAIL_BODIES' in env ? (env.EMAIL_BODIES as R2Bucket) : null;
    const email = await getEmailById(env.DB, id, r2Bucket);
    if (!email) return Response.json({ error: 'Not found' }, { status: 404 });

    return Response.json({
      body_html: email.body_html,
      body_text: email.body_text,
    });
  } catch (error) {
    await captureException(error);
    console.error('[api/emails/[id]/body] failed to load email body:', error);
    return Response.json({ error: 'Failed to load email body' }, { status: 500 });
  }
}
