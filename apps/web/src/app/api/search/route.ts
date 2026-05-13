import { getRequestContext } from '@cloudflare/next-on-pages';
import { searchEmails } from '@q3ik-mail/database';

export const runtime = 'edge';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get('q')?.trim() ?? '';

  if (!query) {
    return Response.json({ error: 'q is required' }, { status: 400 });
  }

  try {
    const { env } = getRequestContext();
    if (!env?.DB) {
      throw new Error('Database binding (DB) is missing');
    }
    return Response.json(await searchEmails(env.DB, query));
  } catch (error) {
    console.error('[api/search] failed to search emails:', error);
    return Response.json({ error: 'Failed to search emails' }, { status: 500 });
  }
}
