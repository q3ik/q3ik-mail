import { Resend } from 'resend';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Read raw body as text BEFORE any parsing — required for signature verification
    const rawBody = await request.text();

    const resend = new Resend(env.RESEND_API_KEY);

    // --- Step 1: Verify webhook signature ---
    let event: ReturnType<typeof resend.webhooks.verify>;
    try {
      // NOTE: resend.webhooks.verify() is async — must be awaited
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
    let receivedEmail: Awaited<ReturnType<typeof resend.emails.receiving.get>>;
    try {
      // Use resend.emails.receiving.get() — NOT resend.emails.get()
      // resend.emails.get() is for sent mail; receiving.get() is for inbound
      receivedEmail = await resend.emails.receiving.get(emailId);
    } catch (_err) {
      return new Response('Failed to fetch email payload', { status: 502 });
    }

    // --- Step 4: Threading logic ---
    // Parse headers array for In-Reply-To to group replies into threads
    const headers: Array<{ name: string; value: string }> = receivedEmail.headers ?? [];

    const inReplyTo = headers.find(
      (h) => h.name.toLowerCase() === 'in-reply-to'
    )?.value ?? null;

    const messageId = headers.find(
      (h) => h.name.toLowerCase() === 'message-id'
    )?.value ?? null;

    // New conversations start their own thread; replies inherit the thread
    const threadId = inReplyTo ?? emailId;

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
          crypto.randomUUID(),  // id
          emailId,              // resend_id
          threadId,             // thread_id
          fromAddress,          // from_address
          fromName,             // from_name (nullable)
          toAddress,            // to_address
          receivedEmail.subject ?? null,
          receivedEmail.text ?? null,
          receivedEmail.html ?? null,
          messageId,            // message_id (nullable)
          inReplyTo,            // in_reply_to (nullable)
        )
        .run();
    } catch (_err) {
      return new Response('Database error', { status: 500 });
    }

    return new Response('OK', { status: 200 });
  },
};
