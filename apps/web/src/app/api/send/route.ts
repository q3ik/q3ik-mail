import { Resend } from 'resend';
import { NextRequest } from 'next/server';
import { getRequestContext } from '@cloudflare/next-on-pages';

export const runtime = 'edge';

const APP_FROM_ADDRESS = 'mail@q3ik.com';
const APP_FROM_NAME = 'q3ik Mail';

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
  return references
    ? `${references} ${replyToId}`
    : replyToId;
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

/**
 * Validates an email address using a structurally sound approach:
 * - Exactly one '@' separator (split-based, not indexOf)
 * - Non-empty local and domain parts
 * - Domain contains a dot, not at start or end
 * - No whitespace anywhere
 *
 * Intentionally does not use a backtracking regex (ReDoS-safe).
 */
function isValidEmail(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parts = value.split('@');
  // Exactly two parts: local @ domain
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (local.length === 0) return false;
  if (domain.length === 0) return false;
  // No whitespace anywhere in the address
  if (/\s/.test(value)) return false;
  // Domain must contain a dot, not at start or end
  const dotIndex = domain.indexOf('.');
  if (dotIndex <= 0 || dotIndex === domain.length - 1) return false;
  return true;
}

export async function POST(req: NextRequest) {
  const { env } = getRequestContext();
  const resend = new Resend(env.RESEND_API_KEY);

  let body: {
    to?: string;
    subject?: string;
    content?: string;
    replyToId?: string;
    references?: string;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { to, subject, content, replyToId, references } = body;

  // Validate all required fields with consistent semantics
  if (!subject || !content) {
    return Response.json({ error: 'Missing required fields: subject, content' }, { status: 400 });
  }

  if (!isValidEmail(to ?? '')) {
    return Response.json({ error: 'Invalid or missing email address' }, { status: 400 });
  }

  try {
    const sentMessageId = `<${crypto.randomUUID()}@q3ik.com>`;
    const persistedReferences = buildReferencesHeader(replyToId, references);
    const result = await resend.emails.send({
      from: `${APP_FROM_NAME} <${APP_FROM_ADDRESS}>`,
      to: [to as string],
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

    try {
      const sentEmailRowId = crypto.randomUUID();
      const { threadId, needsRethreading } = await resolveThreadingMetadata(
        env.DB,
        replyToId,
        sentMessageId
      );

      await env.DB.prepare(`
        INSERT OR IGNORE INTO emails
          (id, resend_id, thread_id, from_address, from_name, to_address, subject, body_text, body_html, message_id, in_reply_to, "references", is_read, is_sent, needs_rethreading)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
      `)
        .bind(
          sentEmailRowId,
          result.data?.id ?? '',
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
    }

    return Response.json({ id: result.data?.id }, { status: 200 });
  } catch (error) {
    console.error('Failed to send email:', error);
    return Response.json({ error: 'Failed to send email' }, { status: 500 });
  }
}
