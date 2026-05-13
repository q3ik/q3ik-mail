import { Resend } from 'resend';
import { NextRequest } from 'next/server';
import { getRequestContext } from '@cloudflare/next-on-pages';
import { captureException } from '@/lib/sentry';
import { z } from 'zod';

/**
 * All 400 responses share this shape so clients have one code path:
 *   { error: { message: string; fieldErrors?: Record<string, string[]> } }
 *
 * - JSON parse failures: message set, fieldErrors absent.
 * - Schema validation failures: message set to a human summary, fieldErrors
 *   populated with Zod's flatten() output for per-field detail.
 */
function errorResponse(
  message: string,
  fieldErrors?: Record<string, string[]>,
  status = 400
): Response {
  return Response.json(
    { error: { message, ...(fieldErrors ? { fieldErrors } : {}) } },
    { status }
  );
}

const SendSchema = z.object({
  to: z.string().trim().email(),
  subject: z.string().trim().min(1),
  content: z.string().trim().min(1),
  // nullish() accepts both null and undefined from JSON clients;
  // the transform normalises both to undefined for downstream functions.
  replyToId: z.string().trim().min(1).nullish().transform((v) => v ?? undefined),
  references: z.string().trim().min(1).nullish().transform((v) => v ?? undefined),
});

export const runtime = 'edge';

const APP_FROM_ADDRESS = 'mail@q3ik.com';
const APP_FROM_NAME = 'q3ik Mail';

export const MAX_REFERENCES_IDS = 12;
export const MAX_REFERENCES_BYTES = 2000;

function buildReferencesHeader(
  replyToId?: string,
  references?: string
): string | null {
  if (!replyToId) return null;
  // RFC 2822 References must be a space-separated chain of all ancestor
  // Message-IDs. `references` is the persisted References value from the
  // replied-to email (stored in D1). Appending `replyToId` grows the chain
  // by one hop for each reply level. If references is absent (e.g. the
  // replied-to email is the thread root), seed the chain with replyToId alone.
  const chain = references
    ? `${references} ${replyToId}`
    : replyToId;

  const ids = chain.split(/\s+/).filter(Boolean);
  if (ids.length === 0) return null;

  const rootId = ids[0];
  const tail = ids.slice(1);
  const dedupedTail = tail.filter((id) => id !== rootId);

  const maxTailIds = Math.max(0, MAX_REFERENCES_IDS - 1);
  let selectedTail = maxTailIds > 0 ? dedupedTail.slice(-maxTailIds) : [];
  let selected = [rootId, ...selectedTail];

  let joined = selected.join(' ');
  while (selectedTail.length > 0 && joined.length > MAX_REFERENCES_BYTES) {
    selectedTail = selectedTail.slice(1);
    selected = [rootId, ...selectedTail];
    joined = selected.join(' ');
  }

  return joined;
}

function buildEmailHeaders(
  messageId: string,
  replyToId?: string,
  references?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'Message-ID': messageId,
  };
  const updatedReferences = buildReferencesHeader(replyToId, references);
  if (!replyToId || !updatedReferences) return headers;

  return {
    ...headers,
    'In-Reply-To': replyToId,
    References: updatedReferences,
  };
}

async function resolveThreadingMetadata(
  db: D1Database,
  replyToId: string | undefined,
  messageId: string
): Promise<{ threadId: string; needsRethreading: 0 | 1 }> {
  if (!replyToId) {
    return { threadId: messageId, needsRethreading: 0 };
  }

  const parentRow = await db
    .prepare('SELECT thread_id FROM emails WHERE message_id = ? LIMIT 1')
    .bind(replyToId)
    .first<{ thread_id: string }>();

  if (parentRow) {
    return { threadId: parentRow.thread_id, needsRethreading: 0 };
  }

  return { threadId: replyToId, needsRethreading: 1 };
}

export async function POST(req: NextRequest) {
  const { env } = getRequestContext();

  let rawBody: unknown;

  try {
    rawBody = await req.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  const parsed = SendSchema.safeParse(rawBody);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    return errorResponse(
      'Validation failed',
      flat.fieldErrors as Record<string, string[]>
    );
  }

  // Resend client instantiated after validation so the allocation is skipped
  // on every fast-fail 400 path (malformed JSON, missing/invalid fields).
  const resend = new Resend(env.RESEND_API_KEY);

  const { to, subject, content, replyToId, references } = parsed.data;

  try {
    const sentMessageId = `<${crypto.randomUUID()}@q3ik.com>`;
    const persistedReferences = buildReferencesHeader(replyToId, references);
    const { threadId, needsRethreading } = await resolveThreadingMetadata(
      env.DB,
      replyToId,
      sentMessageId
    );
    const result = await resend.emails.send({
      from: `${APP_FROM_NAME} <${APP_FROM_ADDRESS}>`,
      to: [to],
      subject,
      text: content,
      headers: buildEmailHeaders(sentMessageId, replyToId, references),
    });

    if (result.error) {
      // Log only non-sensitive error metadata — never log .message which may
      // echo back user input or contain PII-adjacent rate-limit/account details.
      const statusCode =
        'statusCode' in result.error && typeof result.error.statusCode === 'number'
          ? result.error.statusCode
          : undefined;
      console.error('[api/send] Resend error:', result.error.name, statusCode);
      return Response.json({ error: 'Failed to send email' }, { status: 500 });
    }

    const resendId = result.data?.id;
    if (!resendId) {
      console.warn('[api/send] Resend returned success without an id; skipping sent-email persistence');
      return Response.json({ id: null }, { status: 200 });
    }

    try {
      const sentEmailRowId = crypto.randomUUID();
      // Keep the INSERT column list aligned with the bound values below:
      // `is_read` and `is_sent` are intentional literals because sent mail
      // should always be persisted as read + outbound.
      // This write is best-effort because the email has already been accepted
      // by Resend; surfacing a 500 here would risk duplicate sends on retry.
      await env.DB.prepare(`
        INSERT OR IGNORE INTO emails
          (id, resend_id, thread_id, from_address, from_name, to_address, subject, body_text, body_html, message_id, in_reply_to, "references", is_read, is_sent, needs_rethreading)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
      `)
        .bind(
          sentEmailRowId,
          resendId,
          threadId,
          APP_FROM_ADDRESS,
          APP_FROM_NAME,
          to,
          subject,
          content,
          null,
          sentMessageId,
          replyToId ?? null,
          persistedReferences,
          needsRethreading
        )
        .run();
    } catch (error) {
      console.error('[api/send] Failed to persist sent email to D1:', error);
      try {
        await captureException(error);
      } catch (captureError) {
        console.error('[api/send] Failed to capture sent-email persistence error:', captureError);
      }
    }

    return Response.json({ id: resendId }, { status: 200 });
  } catch (error) {
    console.error('Failed to send email:', error);
    return Response.json({ error: 'Failed to send email' }, { status: 500 });
  }
}
