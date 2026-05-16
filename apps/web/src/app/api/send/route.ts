import { Resend } from 'resend';
import { NextRequest } from 'next/server';
import { getRequestContext } from '@cloudflare/next-on-pages';
import { captureException } from '@/lib/sentry';
import { z } from 'zod';
import { buildReferencesHeader } from '@/lib/references';

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

      // Persist sent email body to R2 (same pattern as inbound) to avoid
      // D1 row-size limits on large email content.
      let bodyTextKey: string | null = null;
      const r2Bucket = 'EMAIL_BODIES' in env ? (env.EMAIL_BODIES as R2Bucket) : null;
      if (r2Bucket && content) {
        bodyTextKey = `emails/${sentEmailRowId}/body.txt`;
        try {
          await r2Bucket.put(bodyTextKey, content, {
            httpMetadata: { contentType: 'text/plain; charset=utf-8' },
          });
        } catch (err) {
          console.warn('[api/send] Failed to persist sent body to R2; falling back to inline D1', { err });
          bodyTextKey = null;
        }
      }

      // Keep the INSERT column list aligned with the bound values below:
      // `is_read` and `is_sent` are intentional literals because sent mail
      // should always be persisted as read + outbound.
      // This write is best-effort because the email has already been accepted
      // by Resend; surfacing a 500 here would risk duplicate sends on retry.
      //
      // When R2 write succeeds: body_text=null, body_text_key=key (offloaded)
      // When R2 write fails:    body_text=content, body_text_key=null (inline fallback)
      await env.DB.prepare(`
        INSERT OR IGNORE INTO emails
          (id, resend_id, thread_id, from_address, from_name, to_address, subject, body_text, body_html, body_text_key, body_html_key, message_id, in_reply_to, "references", is_read, is_sent, needs_rethreading)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
      `)
        .bind(
          sentEmailRowId,
          resendId,
          threadId,
          APP_FROM_ADDRESS,
          APP_FROM_NAME,
          to,
          subject,
          bodyTextKey ? null : content,   // inline only if R2 failed
          null,                           // body_html (sent emails are text-only)
          bodyTextKey,                    // body_text_key
          null,                           // body_html_key
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
      return Response.json(
        { error: 'Email sent but failed to save — please refresh.', id: resendId },
        { status: 500 }
      );
    }

    return Response.json({ id: resendId }, { status: 200 });
  } catch (error) {
    console.error('Failed to send email:', error);
    return Response.json({ error: 'Failed to send email' }, { status: 500 });
  }
}
