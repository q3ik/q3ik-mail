import { getCloudflareContext } from '@opennextjs/cloudflare';
import { z } from 'zod';


const TriggerInboundSchema = z.object({
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
  subject: z.string().trim().min(1),
  text: z.string().trim().min(1),
});

/** Loose email format check — rejects obviously malformed addresses before DB insert. */
function isValidEmail(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

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

// SCHEMA DRIFT RISK: ingestInboundEmail duplicates the INSERT logic from the real
// inbound webhook handler. Any column added or renamed in the `emails` table must
// be applied here too, or Scenario A will silently insert incomplete rows.
// Follow-up: extract this into a shared src/lib/ingest-inbound.ts utility once
// the real handler's INSERT is stable enough to factor out.
async function ingestInboundEmail(
  db: D1Database,
  payload: { from: string; to: string; subject: string; text: string }
): Promise<void> {
  const resendId = `trigger-${crypto.randomUUID()}`;
  // thread_id and message_id are intentionally separate UUIDs.
  // thread_id groups messages into a conversation; message_id is the RFC 5322 identifier.
  const threadId = crypto.randomUUID();
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
      threadId,
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
  // Auth check runs first — the deployment guard runs second.
  // Checking env vars before auth would leak the existence of this endpoint to
  // unauthenticated callers via the distinct 401 vs 403 response codes.
  const expectedSecret = process.env.E2E_TEST_SECRET;
  const providedSecret = req.headers.get('x-e2e-test-secret');
  if (!expectedSecret || !providedSecret || providedSecret !== expectedSecret) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // CF_PAGES_BRANCH is the authoritative signal on Cloudflare Pages.
  // NODE_ENV is a secondary guard for local parity; it is not reliably set
  // by the edge runtime and should not be relied upon alone.
  if (process.env.CF_PAGES_BRANCH === 'trunk' || process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
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

  const { name: _name, address: fromAddress } = parseFrom(parsed.data.from);
  if (!isValidEmail(fromAddress)) {
    return Response.json({ error: 'Invalid from address' }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  try {
    await ingestInboundEmail(env.DB, parsed.data);
    return Response.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error('[api/trigger-inbound] Failed to persist synthetic inbound email:', error);
    return Response.json({ error: 'Failed to persist inbound email' }, { status: 500 });
  }
}
