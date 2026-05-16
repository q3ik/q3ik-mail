//import { getRequestContext } from '@cloudflare/next-on-pages';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getEmailById } from '@q3ik-mail/database';
import { captureException } from '@/lib/sentry';
import { UUID_RE } from '@/lib/validation';


export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!UUID_RE.test(id)) {
      return Response.json({ error: 'Invalid email ID format' }, { status: 400 });
    }

    //const { env } = getRequestContext();
    const { env } = getCloudflareContext();

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
