import * as Sentry from '@sentry/cloudflare';
import { Resend } from 'resend';

// Env interface — matches wrangler.toml bindings and secrets
// DB is the D1 binding; secrets are set via `wrangler secret put`
export interface Env {
  DB: D1Database;
  RESEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET: string;
  SENTRY_DSN: string;        // injected via wrangler secret
  ENVIRONMENT: string;       // set in wrangler.toml [vars]
}

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 0.2,
    environment: env.ENVIRONMENT ?? 'production',
  }),
  {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Read raw body as text BEFORE any parsing — required for signature verification
    const rawBody = await request.text();

    const resend = new Resend(env.RESEND_API_KEY);

    // --- Step 1: Verify webhook signature ---
    // Use Awaited<ReturnType<...>> because verify() is async
    // @ts-ignore — resend v4 types don't yet include webhooks; runtime API exists
    let event: Awaited<ReturnType<typeof resend.webhooks.verify>>;
    try {
      // @ts-ignore — resend v4 types don't yet include webhooks; runtime API exists
      event = await resend.webhooks.verify({
        payload: rawBody,
        headers: {
          'svix-id': request.headers.get('svix-id') ?? '',
          'svix-timestamp': request.headers.get('svix-timestamp') ?? '',
          'svix-signature': request.headers.get('svix-signature') ?? '',
        },
        webhookSecret: env.RESEND_WEBHOOK_SECRET,
      });
    } catch (_err) {
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
    // @ts-ignore — resend v4 types don't yet include emails.receiving; runtime API exists
    let receivedEmail: Awaited<ReturnType<typeof resend.emails.receiving.get>>;
    try {
      // Use resend.emails.receiving.get() — NOT resend.emails.get()
      // resend.emails.get() is for sent mail; receiving.get() is for inbound
      // @ts-ignore — resend v4 types don't yet include emails.receiving; runtime API exists
      receivedEmail = await resend.emails.receiving.get(emailId);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { layer: 'worker', operation: 'resend.receiving.get' },
        extra: { emailId },
      });
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

    // Fix: Look up the parent email's thread_id from D1 using the In-Reply-To
    // Message-ID. This ensures multi-level reply chains all share the same
    // root thread_id, rather than each reply forking into its own thread.
    //
    // Strategy:
    //   1. If inReplyTo is set, query emails WHERE message_id = inReplyTo
    //   2. If a parent row is found, reuse its thread_id (may itself be a reply)
    //   3. If no parent found (dangling reference), fall back to messageId ?? emailId
    //   4. New messages (no inReplyTo) start a new thread keyed on messageId ?? emailId
    let threadId: string;
    if (inReplyTo) {
      const parentRow = await env.DB
        .prepare('SELECT thread_id FROM emails WHERE message_id = ? LIMIT 1')
        .bind(inReplyTo)
        .first<{ thread_id: string }>();
      // Use the parent's thread_id if found; otherwise fall back to a new thread
      threadId = parentRow?.thread_id ?? messageId ?? emailId;
    } else {
      // Root message — start a new thread
      threadId = messageId ?? emailId;
    }

    // --- Step 5: Parse from_name and from_address ---
    // Resend returns from as "Display Name <email@example.com>" or just "email@example.com"
    const fromRaw: string = receivedEmail.from ?? '';
    const fromMatch = fromRaw.match(/^(.+?)\s*<(.+?)>$/);
    const fromName = fromMatch ? fromMatch[1].trim() : null;
    const fromAddress = fromMatch ? fromMatch[2].trim() : fromRaw.trim();

    // to_address may be an array — store as comma-separated string
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
          crypto.randomUUID(),        // id
          emailId,                    // resend_id
          threadId,                   // thread_id (looked up or new)
          fromAddress,                // from_address
          fromName,                   // from_name (nullable)
          toAddress,                  // to_address
          receivedEmail.subject ?? null,
          receivedEmail.text ?? null,
          receivedEmail.html ?? null,
          messageId,                  // message_id (nullable)
          inReplyTo,                  // in_reply_to (nullable)
        )
        .run();
    } catch (err) {
      Sentry.captureException(err, {
        tags: { layer: 'worker', operation: 'db.insert' },
        extra: { emailId },
      });
      return new Response('Database error', { status: 500 });
    }

    return new Response('OK', { status: 200 });
  },
} satisfies ExportedHandler<Env>
);
