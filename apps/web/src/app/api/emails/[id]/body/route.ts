import { getRequestContext } from '@cloudflare/next-on-pages';
import { getEmailById } from '@q3ik-mail/database';

export const runtime = 'edge';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { env } = getRequestContext();

  // TODO: proxy this route through the worker once the dedicated worker body API is wired.
  const r2Bucket = 'EMAIL_BODIES' in env ? (env.EMAIL_BODIES as R2Bucket) : null;
  const email = await getEmailById(env.DB, id, r2Bucket);
  if (!email) return Response.json({ error: 'Not found' }, { status: 404 });

  return Response.json({
    body_html: email.body_html,
    body_text: email.body_text,
  });
}
