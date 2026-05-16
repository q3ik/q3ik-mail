import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getThreadListPage } from '@q3ik-mail/database';


const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const requestedLimit = Number.parseInt(
    searchParams.get('limit') ?? String(DEFAULT_LIMIT),
    10
  );
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const cursor = searchParams.get('cursor') ?? undefined;
  const { env } = await getCloudflareContext({ async: true });

  try {
    return Response.json(await getThreadListPage(env.DB, { limit, cursor }));
  } catch (error) {
    console.error('[api/emails] failed to load emails:', error);
    return Response.json({ error: 'Failed to load emails' }, { status: 500 });
  }
}
