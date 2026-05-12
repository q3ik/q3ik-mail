import { getRequestContext } from '@cloudflare/next-on-pages';
import { z } from 'zod';

export const runtime = 'edge';

const TriggerInboundSchema = z.object({
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
  subject: z.string().trim().min(1),
  text: z.string().trim().min(1),
});

function parseFrom(raw: string): { name: string | null; address: string } {
  const quotedMatch = raw.match(/^\s*"([^"]+)"\s*<([^>]+)>\s*$/);
  if (quotedMatch) {
    return { name: quotedMatch[1].trim() || null, address: quotedMatch[2].trim() };
  }
  const unquotedMatch = raw.match(/^([^<]*)<([^>]+)>\s*$/);
  if (unquotedMatch) {
    return { name: unquotedMatch[1].trim() || null, address: unquotedMatch[2].trim() };
  }
  return { name: null, address: raw.trim() };
}

async function ingestInboundEmail(
  db: D1Database,
  payload: { from: string; to: string; subject: string; text: string }
): Promise<void> {
  const resendId = `trigger-${crypto.randomUUID()}`;
  const messageId = `<${crypto.randomUUID()}@q3ik-mail.test>`;
  const { name: fromName, address: fromAddress } = parseFrom(payload.from);

  await db.prepare(`
    INSERT OR IGNORE INTO emails
      (id, resend_id, thread_id, from_address, from_name, to_address, subject, body_text, body_html, message_id, in_reply_to, "references", is_read, is_sent, needs_rethreading)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
  `)
    .bind(
      crypto.randomUUID(),
      resendId,
      messageId,
      fromAddress,
      fromName,
      payload.to,
      payload.subject,
      payload.text,
      null,
      messageId,
      null,
      null
    )
    .run();
}

export async function POST(req: Request) {
  if (process.env.NODE_ENV === 'production' || process.env.CF_PAGES_BRANCH === 'trunk') {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const expectedSecret = process.env.E2E_TEST_SECRET;
  const providedSecret = req.headers.get('TEST_SECRET');
  if (!expectedSecret || !providedSecret || providedSecret !== expectedSecret) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = TriggerInboundSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: 'Validation failed' }, { status: 400 });
  }

  const { env } = getRequestContext();
  try {
    await ingestInboundEmail(env.DB, parsed.data);
    return Response.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error('[api/trigger-inbound] Failed to persist synthetic inbound email:', error);
    return Response.json({ error: 'Failed to persist inbound email' }, { status: 500 });
  }
}
