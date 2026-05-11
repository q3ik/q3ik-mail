import * as Sentry from '@sentry/cloudflare';
import { Webhook } from 'svix';
import { Resend } from 'resend';
import { resolveOrphanedThreads } from '@q3ik-mail/database';

// Shape of the Resend Receiving API response (resend v4 types omit this endpoint).
// Field names verified against https://resend.com/docs/api-reference/inbound
// When Resend ships official types, replace this interface with the proper SDK import.
// TODO: confirm `text` vs `body_text` field name against live API once Resend docs stabilise.
interface ResendReceivedEmail {
  from?: string;
  // Resend may return a single address string or an array; normalise downstream.
  to?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  headers?: Array<{ name: string; value: string }>;
}

// Env interface — matches wrangler.toml bindings and secrets
// DB is the D1 binding; secrets are set via `wrangler secret put`
export interface Env {
  DB: D1Database;
  RESEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET: string;
  SENTRY_DSN?: string;       // optional — worker runs without Sentry if unset
  ENVIRONMENT: string;       // set in wrangler.toml [vars]
}

const handler: ExportedHandler<Env> = {
  // ---------------------------------------------------------------------------
  // Cron Trigger: re-thread orphaned emails on a schedule
  // Replaces the former /api/rethread HTTP endpoint (issue #31).
  // Runs every 5 minutes; resolves emails flagged with needs_rethreading=1.
  // ---------------------------------------------------------------------------
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      resolveOrphanedThreads(env.DB).then((resolved) => {
        if (resolved > 0) {
          console.log(`[cron/rethread] Resolved ${resolved} orphaned thread(s).`);
        }
      }).catch((err) => {
        console.error('[cron/rethread] resolveOrphanedThreads failed:', err);
        if (env.SENTRY_DSN) {
          Sentry.captureException(err, {
            tags: { layer: 'worker', operation: 'cron.rethread' },
          });
        }
      })
    );
  },

  // ---------------------------------------------------------------------------
  // Fetch handler: inbound email webhook from Resend
  // ---------------------------------------------------------------------------
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Read raw body as text BEFORE any parsing — required for signature verification
    const rawBody = await request.text();

    // --- Step 1: Verify webhook signature via svix directly ---
    let event: { type: string; data: { email_id: string } };
    try {
      const wh = new Webhook(env.RESEND_WEBHOOK_SECRET);
      event = wh.verify(rawBody, {
        'svix-id': request.headers.get('svix-id') ?? '',
        'svix-timestamp': request.headers.get('svix-timestamp') ?? '',
        'svix-signature': request.headers.get('svix-signature') ?? '',
      }) as { type: string; data: { email_id: string } };
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

    const resend = new Resend(env.RESEND_API_KEY);

    // --- Step 3: Fetch full email payload from Resend Receiving API ---
    // resend v4 types don't yet include emails.receiving; cast through unknown to call it
    // and assert the expected shape so all downstream field accesses are type-checked.
    let receivedEmail: ResendReceivedEmail;
    try {
      // Use resend.emails.receiving.get() — NOT resend.emails.get()
      // resend.emails.get() is for sent mail; receiving.get() is for inbound
      receivedEmail = await (resend.emails as unknown as { receiving: { get: (id: string) => Promise<ResendReceivedEmail> } }).receiving.get(emailId);
    } catch (err) {
      if (env.SENTRY_DSN) {
        Sentry.captureException(err, {
          tags: { layer: 'worker', operation: 'resend.receiving.get' },
          extra: { emailId },
        });
      }
      return new Response('Failed to fetch email payload', { status: 502 });
    }

    // --- Runtime shape guard ---
    // The API response is cast from `any`; validate the minimum required shape
    // before proceeding so that API drift surfaces immediately as a 502 rather
    // than silently writing nulls into D1.
    if (!receivedEmail || typeof receivedEmail !== 'object') {
      console.error('[worker] Resend receiving API returned unexpected payload type:', typeof receivedEmail);
      return new Response('Invalid email payload from upstream', { status: 502 });
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

    const referencesHeader = emailHeaders.find(
      (h) => h.name.toLowerCase() === 'references'
    )?.value ?? null;

    // Fix: Look up the parent email's thread_id from D1 using the In-Reply-To
    // Message-ID. This ensures multi-level reply chains all share the same
    // root thread_id, rather than each reply forking into its own thread.
    //
    // Strategy:
    //   1. If inReplyTo is set, query emails WHERE message_id = inReplyTo
    //   2. If a parent row is found, reuse its thread_id (may itself be a reply)
    //   3. If no parent found (out-of-order delivery), use inReplyTo as thread_id
    //      and flag for re-threading once the parent arrives
    //   4. New messages (no inReplyTo) start a new thread keyed on messageId ?? emailId
    let threadId: string;
    let needsRethreading = 0;
    if (inReplyTo) {
      const parentRow = await env.DB
        .prepare('SELECT thread_id FROM emails WHERE message_id = ? LIMIT 1')
        .bind(inReplyTo)
        .first<{ thread_id: string }>();
      if (parentRow) {
        // Parent found — join existing thread
        threadId = parentRow.thread_id;
      } else {
        // Parent not yet received — use In-Reply-To value as thread_id for now
        // and flag for re-threading once the parent arrives
        threadId = inReplyTo;
        needsRethreading = 1;
        console.warn(`[threading] Parent not found for In-Reply-To: ${inReplyTo}. Flagged for re-threading.`);
      }
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

    // Normalise `to` to a string regardless of whether the API returns a bare
    // string or an array — both branches are now handled explicitly.
    const toRaw = receivedEmail.to;
    const toAddress = Array.isArray(toRaw)
      ? toRaw.join(', ')
      : (typeof toRaw === 'string' ? toRaw : '');

    // --- Step 6: Persist to D1 ---
    try {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO emails
          (id, resend_id, thread_id, from_address, from_name, to_address, subject, body_text, body_html, message_id, in_reply_to, "references", is_read, is_sent, needs_rethreading)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
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
          referencesHeader,           // references (nullable)
          needsRethreading,           // needs_rethreading (0 or 1)
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
} satisfies ExportedHandler<Env>;

export default Sentry.withSentry(
  (env: Env) => env.SENTRY_DSN
    ? {
        dsn: env.SENTRY_DSN,
        tracesSampleRate: 0.2,
        environment: env.ENVIRONMENT ?? 'production',
      }
    : undefined,
  handler,
);
