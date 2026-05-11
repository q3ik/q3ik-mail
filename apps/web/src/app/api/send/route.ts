import { Resend } from 'resend';
import { NextRequest } from 'next/server';
import { getRequestContext } from '@cloudflare/next-on-pages';

export const runtime = 'edge';

function buildEmailHeaders(
  replyToId?: string,
  references?: string
): Record<string, string> | undefined {
  if (!replyToId) return undefined;
  // RFC 2822 References must be a space-separated chain of all ancestor
  // Message-IDs. `references` is the persisted References value from the
  // replied-to email (stored in D1). Appending `replyToId` grows the chain
  // by one hop for each reply level. If references is absent (e.g. the
  // replied-to email is the thread root), seed the chain with replyToId alone.
  const updatedReferences = references
    ? `${references} ${replyToId}`
    : replyToId;
  return {
    'In-Reply-To': replyToId,
    References: updatedReferences,
  };
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
    const result = await resend.emails.send({
      from: 'q3ik Mail <mail@q3ik.com>',
      to: [to as string],
      subject,
      text: content,
      headers: buildEmailHeaders(replyToId, references),
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

    return Response.json({ id: result.data?.id }, { status: 200 });
  } catch (error) {
    console.error('Failed to send email:', error);
    return Response.json({ error: 'Failed to send email' }, { status: 500 });
  }
}
