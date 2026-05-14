import { getRequestContext } from '@cloudflare/next-on-pages';
import { getEmailById, markAsRead } from '@q3ik-mail/database';
import { captureException } from '@/lib/sentry';

export const runtime = 'edge';

/** Validates that a string is a well-formed UUID v4 (lowercase hex + hyphens). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!UUID_RE.test(id)) {
      return Response.json({ error: 'Invalid email ID format' }, { status: 400 });
    }

    const { env } = getRequestContext();
    const r2Bucket = 'EMAIL_BODIES' in env ? (env.EMAIL_BODIES as R2Bucket) : null;
    const email = await getEmailById(env.DB, id, r2Bucket);
    if (!email) return Response.json({ error: 'Not found' }, { status: 404 });

    // markAsRead is a best-effort side-effect. A D1 write failure must not
    // turn a successful GET into a 500 — the email data is already in memory.
    if (!email.is_read) {
      try {
        await markAsRead(env.DB, id);
      } catch (err) {
        console.error('[emails/[id]] markAsRead failed:', err);
      }
    }

    return Response.json({
      id: email.id,
      thread_id: email.thread_id,
      resend_id: email.resend_id,
      from_address: email.from_address,
      from_name: email.from_name,
      to_address: email.to_address,
      subject: email.subject,
      body_text: email.body_text,
      body_html: email.body_html,
      message_id: email.message_id,
      in_reply_to: email.in_reply_to,
      references: email.references,
      is_read: email.is_read,
      is_sent: email.is_sent,
      created_at: email.created_at,
    });
  } catch (error) {
    await captureException(error);
    console.error('[api/emails/[id]] failed to load email:', error);
    return Response.json({ error: 'Failed to load email' }, { status: 500 });
  }
}
