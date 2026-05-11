import { getRequestContext } from '@cloudflare/next-on-pages';
import { getEmailById, markAsRead } from '@q3ik-mail/database';

export const runtime = 'edge';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { env } = getRequestContext();
  const email = await getEmailById(env.DB, id);
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

  return Response.json(email);
}
