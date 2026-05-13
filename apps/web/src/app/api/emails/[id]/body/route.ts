import * as Sentry from '@sentry/cloudflare';
import { getRequestContext } from '@cloudflare/next-on-pages';
import { getEmailById } from '@q3ik-mail/database';

export const runtime = 'edge';

/**
 * Validates the Cloudflare Access JWT from the CF-Access-Jwt-Assertion header.
 * Returns true if the token is present and well-formed (3-part JWT).
 * Full cryptographic verification is handled upstream by Cloudflare Access;
 * this guard ensures the route is never served without the Access layer active.
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
      Sentry.captureMessage('[api/email-body] missing or malformed Cloudflare Access JWT', {
        level: 'warning',
        tags: { category: 'security-auth', surface: 'api.email-body', auth_provider: 'cloudflare-access' },
        extra: { path: new URL(req.url).pathname },
      });
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const { env } = getRequestContext();

    const r2Bucket = 'EMAIL_BODIES' in env ? (env.EMAIL_BODIES as R2Bucket) : null;
    const email = await getEmailById(env.DB, id, r2Bucket);
    if (!email) return Response.json({ error: 'Not found' }, { status: 404 });

    return Response.json({
      body_html: email.body_html,
      body_text: email.body_text,
    });
  } catch (error) {
    console.error('[api/emails/[id]/body] failed to load email body:', error);
    return Response.json({ error: 'Failed to load email body' }, { status: 500 });
  }
}
