import * as Sentry from '@sentry/cloudflare';
import { Resend } from 'resend';
import { Webhook } from 'svix';

// Env interface — matches wrangler.toml bindings and secrets
// DB is the D1 binding; secrets are set via `wrangler secret put`
export interface Env {
  DB: D1Database;
  RESEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET: string;
  SENTRY_DSN?: string;       // optional — worker degrades gracefully if not set
  ENVIRONMENT: string;       // set in wrangler.toml [vars]
}

// Shape of a verified Resend webhook event
interface ResendWebhookEvent {
  type: string;
  data: { email_id: string };
}

// Shape of the inbound email payload from the Resend receiving API
interface ReceivedEmail {
  from?: string;
  to?: string | string[];
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  headers?: Array<{ name: string; value: string }>;
}

// Typed accessor for the Resend inbound-email receiving API.
// resend.emails.receiving is a newer endpoint not yet reflected in the
// published SDK type declarations; this wrapper avoids a blanket `any` cast.
interface ResendReceiving {
  get(emailId: string): Promise<ReceivedEmail>;
}
interface ResendEmailsWithReceiving {
  receiving: ResendReceiving;
}

const handler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Read raw body as text BEFORE any parsing — required for signature verification
    const rawBody = await request.text();

    // --- Step 1: Verify webhook signature via svix ---
    let event: ResendWebhookEvent;
    try {
      const wh = new Webhook(env.RESEND_WEBHOOK_SECRET);
      event = wh.verify(rawBody, {
        'svix-id': request.headers.get('svix-id') ?? '',
        'svix-timestamp': request.headers.get('svix-timestamp') ?? '',
        'svix-signature': request.headers.get('svix-signature') ?? '',
      }) as ResendWebhookEvent;
    } catch {
      // Signature mismatch or missing headers
      return new Response('Unauthorized', { status: 401 });
    }

    // --- Step 2: Only process email.received events ---
    if (event.type !== 'email.received') {
      // Acknowledge other event types without processing
      return new Response('OK', { status: 200 });
    }

    const emailId = event.data.email_id;

    // --- Step 3: Fetch full email payload from Resend Receiving API ---
    // Use resend.emails.receiving.get() — NOT resend.emails.get()
    // resend.emails.get() is for sent mail; receiving.get() is for inbound
    const resend = new Resend(env.RESEND_API_KEY);
    let receivedEmail: ReceivedEmail;
    try {
      receivedEmail = await (resend.emails as unknown as ResendEmailsWithReceiving).receiving.get(emailId);
    } catch (err) {
      if (env.SENTRY_DSN) {
        Sentry.captureException(err, {
          tags: { layer: 'worker', operation: 'resend.receiving.get' },
          extra: { emailId },
        });
      }
      return new Response('Failed to fetch email payload', { status: 502 });
    }

    // --- Step 4: Threading logic ---
    // Parse headers array for In-Reply-To and Message-ID
    const emailHeaders: Array<{ name: string; value: string }> = receivedEmail.headers ?? [];

    const inReplyTo = emailHeaders.find(
      (h) => h.name.toLowerCase() === 'in-reply-to'
    )?.value ?? null;

    const messageId = emailHeaders.find(
      (h) => h.name.toLowerCase() === 'message-id'
    )?.value ?? null;

    // Look up the parent email's thread_id from D1 using the In-Reply-To
    // Message-ID so multi-level reply chains share the same root thread_id.
    let threadId: string;
    if (inReplyTo) {
      const parentRow = await env.DB
        .prepare('SELECT thread_id FROM emails WHERE message_id = ? LIMIT 1')
        .bind(inReplyTo)
        .first<{ thread_id: string }>();
      threadId = parentRow?.thread_id ?? messageId ?? emailId;
    } else {
      threadId = messageId ?? emailId;
    }

    // --- Step 5: Parse from_name and from_address ---
    const fromRaw: string = receivedEmail.from ?? '';
    const fromMatch = fromRaw.match(/^(.+?)\s*<(.+?)>$/);
    const fromName = fromMatch ? fromMatch[1].trim() : null;
    const fromAddress = fromMatch ? fromMatch[2].trim() : fromRaw.trim();

    const toAddress = Array.isArray(receivedEmail.to)
      ? receivedEmail.to.join(', ')
      : (receivedEmail.to ?? '');

    // --- Step 6: Persist to D1 ---
    try {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO emails
          (id, resend_id, thread_id, from_address, from_name, to_address, subject, body_text, body_html, message_id, in_reply_to, is_read, is_sent)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
      `)
        .bind(
          crypto.randomUUID(),
          emailId,
          threadId,
          fromAddress,
          fromName,
          toAddress,
          receivedEmail.subject ?? null,
          receivedEmail.text ?? null,
          receivedEmail.html ?? null,
          messageId,
          inReplyTo,
        )
        .run();
    } catch (err) {
      if (env.SENTRY_DSN) {
        Sentry.captureException(err, {
          tags: { layer: 'worker', operation: 'db.insert' },
          extra: { emailId },
        });
      }
      return new Response('Database error', { status: 500 });
    }

    return new Response('OK', { status: 200 });
  },
};

// Wrap with Sentry only when SENTRY_DSN is configured.
// This lets the worker run in local dev and CI without the secret being set.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.SENTRY_DSN) {
      return handler.fetch!(request, env, ctx);
    }
    return Sentry.withSentry(
      () => ({
        dsn: env.SENTRY_DSN as string,
        tracesSampleRate: 0.2,
        environment: env.ENVIRONMENT ?? 'production',
      }),
      handler,
    ).fetch!(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
