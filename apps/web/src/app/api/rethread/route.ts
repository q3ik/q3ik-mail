import { getRequestContext } from '@cloudflare/next-on-pages';
import { resolveOrphanedThreads } from '@q3ik-mail/database';

export const runtime = 'edge';

// ⚠️ Security note: This endpoint has no auth guard.
// Before deploying to production, add a check against an ADMIN_SECRET env var,
// or remove the route entirely and use a Cron Trigger instead.
export async function POST() {
  const { env } = getRequestContext();
  const resolved = await resolveOrphanedThreads(env.DB);
  return Response.json({ resolved });
}
