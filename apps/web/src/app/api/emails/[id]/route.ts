import { getRequestContext } from '@cloudflare/next-on-pages';
import { getEmailById, markAsRead } from '@q3ik-mail/database';
import { captureException } from '@/lib/sentry';

export const runtime = 'edge';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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

    const {
      id: emailId,
      thread_id,
      resend_id,
      from_address,
      from_name,
      to_address,
      subject,
      body_text,
      body_html,
      message_id,
      in_reply_to,
      references,
      is_read,
      is_sent,
      created_at,
    } = email;

    return Response.json({
      id: emailId,
      thread_id,
      resend_id,
      from_address,
      from_name,
      to_address,
      subject,
      body_text,
      body_html,
      message_id,
      in_reply_to,
      references,
      is_read,
      is_sent,
      created_at,
    });
  } catch (error) {
    await captureException(error);
    console.error('[api/emails/[id]] failed to load email:', error);
    return Response.json({ error: 'Failed to load email' }, { status: 500 });
  }
}
