import { Resend } from 'resend';
import { NextRequest } from 'next/server';
import { getRequestContext } from '@cloudflare/next-on-pages';

export const runtime = 'edge';

function buildEmailHeaders(
  replyToId?: string,
  references?: string
): Record<string, string> | undefined {
  if (!replyToId) return undefined;
  // RFC 2822: References accumulates all ancestor Message-IDs in the thread.
  // thread_id is the Message-ID of the first email in the thread, which is a
  // valid starting point for References if we don't have a full chain yet.
  const updatedReferences = references
    ? `${references} ${replyToId}`
    : replyToId;
  return {
    'In-Reply-To': replyToId,
    References: updatedReferences,
  };
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

  if (!subject || !content) {
    return Response.json({ error: 'Missing required fields: subject, content' }, { status: 400 });
  }

  if (typeof to !== 'string' || to.length === 0) {
    return Response.json({ error: 'Invalid or missing email address' }, { status: 400 });
  }

  // Validate email format: must have '@' not at start/end, and domain must contain a dot
  const atIndex = to.indexOf('@');
  const validEmail = atIndex > 0 && atIndex < to.length - 1 && to.slice(atIndex + 1).includes('.');
  if (!validEmail) {
    return Response.json({ error: 'Invalid or missing email address' }, { status: 400 });
  }

  try {
    const result = await resend.emails.send({
      from: 'q3ik Mail <mail@q3ik.com>',
      to: [to],
      subject,
      text: content,
      headers: buildEmailHeaders(replyToId, references),
    });

    if (result.error) {
      console.error('[api/send] Resend error:', result.error);
      return Response.json({ error: 'Failed to send email' }, { status: 500 });
    }

    return Response.json({ id: result.data?.id }, { status: 200 });
  } catch (error) {
    console.error('Failed to send email:', error);
    return Response.json({ error: 'Failed to send email' }, { status: 500 });
  }
}
