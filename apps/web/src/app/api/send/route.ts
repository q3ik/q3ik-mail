import { Resend } from 'resend';
import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { captureException } from '@/lib/sentry';
import { z } from 'zod';
import { MAX_REFERENCES_BYTES, buildReferencesHeader } from '@/lib/references';

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
  replyToId: z.string().trim().min(1).max(MAX_REFERENCES_BYTES).nullish().transform((v) => v ?? undefined),
  references: z.string().trim().min(1).max(MAX_REFERENCES_BYTES).nullish().transform((v) => v ?? undefined),
});


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

/**
 * Outbox pattern: persist intent → send → update status.
 *
 * 1. INSERT a 'pending_send' row with a placeholder resend_id.
 *    If this fails, no email is sent — safe for the user to retry.
 * 2. Call Resend to deliver the email.
 * 3. On success: UPDATE status='sent' and set the real resend_id.
 *    On failure: UPDATE status='send_failed'.
 *
 * This eliminates the silent-data-loss window from the old fire-and-forget
 * approach: every send attempt is recorded, and failures are visible.
 */
export async function POST(req: NextRequest) {
  const { env } = await getCloudflareContext({ async: true });

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
    const sentEmailRowId = crypto.randomUUID();
    const sentMessageId = `<${crypto.randomUUID()}@q3ik.com>`;
    // Placeholder resend_id satisfies NOT NULL + UNIQUE until Resend returns the real one.
    const placeholderResendId = `pending:${sentEmailRowId}`;
    const persistedReferences = buildReferencesHeader(replyToId, references);
    const { threadId, needsRethreading } = await resolveThreadingMetadata(
      env.DB,
      replyToId,
      sentMessageId
    );

    // ── Step 1: R2 body offload ───────────────────────────────────────────
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

    // ── Step 2: Persist intent record (pending_send) ──────────────────────
    // If this INSERT fails, no email is sent — the user can safely retry.
    try {
      await env.DB.prepare(`
        INSERT INTO emails
          (id, resend_id, thread_id, from_address, from_name, to_address, subject, body_text, body_html, body_text_key, body_html_key, message_id, in_reply_to, "references", is_read, is_sent, needs_rethreading, status)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 'pending_send')
      `)
        .bind(
          sentEmailRowId,
          placeholderResendId,
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
      console.error('[api/send] Failed to persist send intent to D1:', error);
      try { await captureException(error); } catch { /* best-effort */ }
      // No email was sent — safe for user to retry.
      return Response.json(
        { error: { message: 'Failed to queue email for sending — please retry.' } },
        { status: 500 }
      );
    }

    // ── Step 3: Send via Resend ───────────────────────────────────────────
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

      // Mark as failed so the row is visible but not confused with a sent email.
      try {
        await env.DB.prepare(`UPDATE emails SET status = 'send_failed' WHERE id = ?`)
          .bind(sentEmailRowId)
          .run();
      } catch (updateErr) {
        console.error('[api/send] Failed to mark email as send_failed:', updateErr);
        try { await captureException(updateErr); } catch { /* best-effort */ }
      }

      return Response.json({ error: { message: 'Failed to send email' } }, { status: 500 });
    }

    // ── Step 4: Finalise — update status to 'sent' + real resend_id ──────
    const resendId = result.data?.id;

    try {
      if (resendId) {
        await env.DB.prepare(`UPDATE emails SET status = 'sent', resend_id = ? WHERE id = ?`)
          .bind(resendId, sentEmailRowId)
          .run();
      } else {
        // Resend returned success without an id — unusual but not fatal.
        // Keep placeholder resend_id; mark as sent so the row is visible.
        console.warn('[api/send] Resend returned success without an id; keeping placeholder resend_id');
        await env.DB.prepare(`UPDATE emails SET status = 'sent' WHERE id = ?`)
          .bind(sentEmailRowId)
          .run();
      }
    } catch (error) {
      // Email was sent but we couldn't update the DB record.
      // The row exists as 'pending_send' — detectable and recoverable.
      console.error('[api/send] Failed to finalise sent email in D1:', error);
      try { await captureException(error); } catch { /* best-effort */ }
      return Response.json(
        { error: { message: 'Email sent but failed to save — please refresh.' }, id: resendId },
        { status: 500 }
      );
    }

    return Response.json({ id: resendId ?? null }, { status: 200 });
  } catch (error) {
    console.error('Failed to send email:', error);
    return Response.json({ error: { message: 'Failed to send email' } }, { status: 500 });
  }
}
