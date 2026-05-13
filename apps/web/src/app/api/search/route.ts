import { getRequestContext } from '@cloudflare/next-on-pages';
import { searchEmails } from '@q3ik-mail/database';
import { captureException } from '@/lib/sentry';

export const runtime = 'edge';

async function handleSearchError(error: unknown): Promise<Response> {
  console.error('[api/search] failed to search emails:', error);
  try {
    await captureException(error);
  } catch (captureError) {
    console.error('[api/search] failed to capture search error:', captureError);
  }
  return Response.json({ error: 'Failed to search emails' }, { status: 500 });
}

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
    return handleSearchError(error);
  }
}
