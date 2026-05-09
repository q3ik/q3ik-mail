import { getRequestContext } from '@cloudflare/next-on-pages';
import { Resend } from 'resend';

export const runtime = 'edge';

export async function POST(req: Request) {
  const { env } = getRequestContext();
  const body = (await req.json()) as {
    to: string;
    subject: string;
    content: string;
    replyToMessageId?: string;
    references?: string;
  };

  if (!body.to || !body.subject || !body.content) {
    return Response.json(
      { error: 'Missing required fields: to, subject, content' },
      { status: 400 }
    );
  }

  const resend = new Resend(env.RESEND_API_KEY);

  const headers: Record<string, string> = {};
  if (body.replyToMessageId) {
    headers['In-Reply-To'] = body.replyToMessageId;
    headers['References'] = body.references
      ? `${body.references} ${body.replyToMessageId}`
      : body.replyToMessageId;
  }

  // TODO: replace with verified Resend sender domain
  const { data, error } = await resend.emails.send({
    from: 'q3ik-mail <mail@q3ik.com>',
    to: [body.to],
    subject: body.subject,
    html: `<div>${body.content}</div>`,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  });

  if (error) {
    console.error('[send] Resend error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ id: data?.id });
}
