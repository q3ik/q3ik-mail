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
  if (!email.is_read) await markAsRead(env.DB, id);
  return Response.json(email);
}
