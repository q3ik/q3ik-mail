import * as Sentry from '@sentry/cloudflare';
import { Webhook } from 'svix';
import { Resend } from 'resend';
import { resolveOrphanedThreads } from '@q3ik-mail/database';
import { parseFrom } from './utils/parseFrom';
import { validateCfAccessJwt } from './middleware/cfAccess';

// Shape of the Resend Receiving API response (resend v4 types omit this endpoint).
// Field names verified against https://resend.com/docs/api-reference/webhooks/email-received
// When Resend ships official types, replace this interface with the proper SDK import.
interface ResendReceivedEmail {
  from?: string;
  // Resend may return a single address string or an array; normalise downstream.
  to?: string | string[];
  subject?: string;
  // `text` is nullable but not guaranteed present on every event (HTML-only senders
  // may omit the key entirely). Treat as optional; normalise to null downstream.
  text?: string | null;
  html?: string | null;
  attachments?: ResendReceivedAttachment[];
  headers?: Array<{ name: string; value: string }>;
}

interface ResendReceivedAttachment {
  id?: string;
  filename?: string;
  content?: string;
  content_type?: string;
  contentType?: string;
  url?: string;
  size?: number;
  content_length?: number;
}

/**
 * Validates and narrows an unknown Resend receiving-API payload to
 * `ResendReceivedEmail`. Returns `null` plus the name of the offending field
 * when validation fails so callers can emit a diagnostic log entry.
 *
 * Key invariants:
 * - Only `object` payloads are accepted.
 * - `text` is optional (HTML-only emails may omit the key), but when present
 *   it must be `string | null`. Do NOT require its presence — that would cause
 *   a 502 for every HTML-only inbound message.
 * - All other fields are individually optional and type-checked when present.
 * - Inner collection types (headers array) use `Record<string, unknown>` to
 *   preserve exhaustiveness checking as the interface evolves.
 */
function parseResendReceivedEmail(
  payload: unknown,
): { ok: true; email: ResendReceivedEmail } | { ok: false; field: string } {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, field: '(root)' };
  }

  // Use `unknown` (not `any`) so the compiler enforces explicit narrowing on
  // every property access and exhaustiveness checks remain intact.
  const email = payload as Record<string, unknown>;

  // `text` — optional; when present must be string | null
  if ('text' in email && email.text !== null && typeof email.text !== 'string') {
    return { ok: false, field: 'text' };
  }

  if (email.from !== undefined && typeof email.from !== 'string') {
    return { ok: false, field: 'from' };
  }

  if (
    email.to !== undefined &&
    typeof email.to !== 'string' &&
    !(
      Array.isArray(email.to) &&
      (email.to as unknown[]).every((item) => typeof item === 'string')
    )
  ) {
    return { ok: false, field: 'to' };
  }

  if (email.subject !== undefined && typeof email.subject !== 'string') {
    return { ok: false, field: 'subject' };
  }

  if (email.html !== undefined && email.html !== null && typeof email.html !== 'string') {
    return { ok: false, field: 'html' };
  }

  if (email.headers !== undefined) {
    if (!Array.isArray(email.headers)) {
      return { ok: false, field: 'headers' };
    }
    for (const header of email.headers as unknown[]) {
      if (!header || typeof header !== 'object') {
        return { ok: false, field: 'headers[*]' };
      }
      const h = header as Record<string, unknown>;
      if (typeof h.name !== 'string' || typeof h.value !== 'string') {
        return { ok: false, field: 'headers[*].name/value' };
      }
    }
  }

  if (email.attachments !== undefined) {
    if (!Array.isArray(email.attachments)) {
      return { ok: false, field: 'attachments' };
    }
    for (const attachment of email.attachments as unknown[]) {
      if (!attachment || typeof attachment !== 'object') {
        return { ok: false, field: 'attachments[*]' };
      }
      const a = attachment as Record<string, unknown>;
      if (a.id !== undefined && typeof a.id !== 'string') {
        return { ok: false, field: 'attachments[*].id' };
      }
      if (a.filename !== undefined && typeof a.filename !== 'string') {
        return { ok: false, field: 'attachments[*].filename' };
      }
      if (a.content !== undefined && typeof a.content !== 'string') {
        return { ok: false, field: 'attachments[*].content' };
      }
      if (a.content_type !== undefined && typeof a.content_type !== 'string') {
        return { ok: false, field: 'attachments[*].content_type' };
      }
      if (a.contentType !== undefined && typeof a.contentType !== 'string') {
        return { ok: false, field: 'attachments[*].contentType' };
      }
      if (a.url !== undefined && typeof a.url !== 'string') {
        return { ok: false, field: 'attachments[*].url' };
      }
      if (a.size !== undefined && typeof a.size !== 'number') {
        return { ok: false, field: 'attachments[*].size' };
      }
      if (a.content_length !== undefined && typeof a.content_length !== 'number') {
        return { ok: false, field: 'attachments[*].content_length' };
      }
    }
  }

  return {
    ok: true,
    email: {
      from: typeof email.from === 'string' ? email.from : undefined,
      to:
        typeof email.to === 'string' || Array.isArray(email.to)
          ? (email.to as string | string[])
          : undefined,
      subject: typeof email.subject === 'string' ? email.subject : undefined,
      text:
        typeof email.text === 'string' || email.text === null
          ? (email.text as string | null)
          : undefined,
      html:
        typeof email.html === 'string' || email.html === null
          ? (email.html as string | null)
          : undefined,
      headers: Array.isArray(email.headers)
        ? (email.headers as Array<{ name: string; value: string }>)
        : undefined,
      attachments: Array.isArray(email.attachments)
        ? (email.attachments as ResendReceivedAttachment[])
        : undefined,
    },
  };
}

function getBodyHtmlKey(emailInternalId: string): string {
  return `emails/${emailInternalId}/body.html`;
}

function getBodyTextKey(emailInternalId: string): string {
  return `emails/${emailInternalId}/body.txt`;
}

/**
 * Sanitizes a user-supplied attachment filename into a safe R2 key segment.
 *
 * Defenses applied:
 * - Strip path traversal sequences (`..` runs).
 * - Remove null bytes.
 * - Remove characters illegal in most filesystems and R2 keys.
 * - Percent-encode remaining non-ASCII characters to prevent homoglyph attacks.
 * - Enforce a 200-character max length on the final segment.
 */
function sanitizeAttachmentFilename(filename: string, index: number): string {
  const trimmed = filename.trim();
  const base = trimmed.length > 0 ? trimmed : `attachment-${index + 1}`;
  const normalized = base
    // Remove null bytes
    .replaceAll('\0', '')
    // Collapse path traversal sequences
    .replace(/\.{2,}/g, '_')
    // Remove filesystem/R2-unsafe characters
    .replace(/[\\/?%*:|"<>]/g, '_');

  // Percent-encode non-ASCII characters to neutralise homoglyphs.
  // (Avoid control-character regex ranges to satisfy no-control-regex lint rule.)
  let asciiSafe = '';
  for (const ch of normalized) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    // Encode ASCII control chars (C0 range 0x00-0x1F and DEL 0x7F) and all
    // non-ASCII chars (> 0x7F) into percent-escaped sequences.
    const shouldEncode =
      code <= 0x1f ||
      code === 0x7f ||
      code > 0x7f;
    asciiSafe += shouldEncode ? encodeURIComponent(ch) : ch;
  }

  // Enforce max filename length (R2 key limit is 1024 bytes total; cap segment at 200)
  return asciiSafe.slice(0, 200);
}

/**
 * Decodes a base64 string to Uint8Array in chunks to avoid blocking the
 * Workers event loop for large attachments. atob is synchronous; chunking
 * keeps individual CPU slices short.
 */
function decodeBase64ToUint8Array(base64: string): Uint8Array {
  // Normalize URL-safe base64 (RFC 4648 §5) before decoding.
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');

  const uint8ArrayWithFromBase64 = Uint8Array as Uint8ArrayConstructor & {
    fromBase64?: (input: string) => Uint8Array;
  };
  if (typeof uint8ArrayWithFromBase64.fromBase64 === 'function') {
    return uint8ArrayWithFromBase64.fromBase64(padded);
  }

  const CHUNK = 65_536;

  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < padded.length) {
    const slice = padded.slice(offset, offset + CHUNK);
    const binary = atob(slice);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    chunks.push(bytes);
    offset += CHUNK;
  }
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return result;
}

/**
 * Downloads attachment content from Resend.
 *
 * @param attachment   - Parsed attachment descriptor from Resend payload
 * @param resendEmailId - The Resend external email ID (NOT the internal UUID)
 * @param resendApiKey  - Bearer token for Resend API calls
 */
async function loadAttachmentContent(
  attachment: ResendReceivedAttachment,
  resendEmailId: string,
  resendApiKey: string
): Promise<ArrayBuffer | Uint8Array | string | ReadableStream<Uint8Array> | null> {
  if (attachment.content) {
    try {
      return decodeBase64ToUint8Array(attachment.content);
    } catch (err) {
      console.warn('[worker] attachment content is not valid base64; storing raw string', {
        resendEmailId,
        error: err,
      });
      return attachment.content;
    }
  }

  if (attachment.url) {
    const response = await fetch(attachment.url, {
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
      },
    });
    if (!response.ok) {
      return null;
    }
    return response.body ?? null;
  }

  if (attachment.id) {
    const response = await fetch(
      `https://api.resend.com/emails/receiving/${encodeURIComponent(resendEmailId)}/attachments/${encodeURIComponent(attachment.id)}`,
      {
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
        },
      }
    );
    if (!response.ok) {
      return null;
    }
    return response.body ?? null;
  }

  return null;
}

function parseAttachmentLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function estimateAttachmentBytes(attachment: ResendReceivedAttachment): number {
  if (typeof attachment.content_length === 'number' && attachment.content_length >= 0) {
    return attachment.content_length;
  }
  if (typeof attachment.size === 'number' && attachment.size >= 0) {
    return attachment.size;
  }
  if (typeof attachment.content === 'string') {
    return Math.floor((attachment.content.length * 3) / 4);
  }
  return 0;
}

// Env interface -- matches wrangler.toml bindings and secrets
// DB is the D1 binding; secrets are set via `wrangler secret put`
// EMAIL_BODIES is optional: the worker degrades gracefully (body keys = null)
// if the bucket is not bound (e.g. local dev without R2 configured).
export interface Env {
  DB: D1Database;
  EMAIL_BODIES?: R2Bucket;
  WEBHOOK_RATE_LIMITER: {
    limit: (input: { key: string }) => Promise<{ success: boolean }>;
  };
  RESEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET: string;
  /** AUD tag from the Cloudflare Access application. Set via `wrangler secret put CLOUDFLARE_ACCESS_AUD`. */
  CLOUDFLARE_ACCESS_AUD: string;
  /** Your Zero Trust team domain, e.g. "yourteam.cloudflareaccess.com". Set via `wrangler secret put CLOUDFLARE_TEAM_DOMAIN`. */
  CLOUDFLARE_TEAM_DOMAIN: string;
  SENTRY_DSN?: string;           // optional -- worker runs without Sentry if unset
  ENVIRONMENT: string;           // set in wrangler.toml [vars]
  MAX_TOTAL_ATTACHMENT_BYTES?: string;
  MAX_SINGLE_ATTACHMENT_BYTES?: string;
}

/**
 * Captures an R2 put failure to Sentry when the DSN is configured.
 * Centralises the duplicated catch-block logic for body_text and body_html
 * persistence so each catch site is a single call.
 */
function captureR2PutError(
  err: unknown,
  env: Env,
  ctx: { emailId: string; operation: string; objectKey: string | null },
): void {
  console.warn(
    `[worker] failed to persist ${ctx.operation} to R2; proceeding with null key`,
    { emailId: ctx.emailId, err },
  );
  if (env.SENTRY_DSN) {
    Sentry.captureException(err, {
      tags: {
        layer: 'worker',
        operation: `r2.put.${ctx.operation}`,
        storage_provider: 'r2',
        ...(ctx.objectKey ? { r2_object_key: ctx.objectKey } : {}),
      },
      extra: { emailId: ctx.emailId },
    });
  }
}

// Issue 1 fix: TextEncoder is stateless; hoist to module scope to avoid
// re-allocating it on every webhook invocation that processes attachments.
const textEncoder = new TextEncoder();

const handler: ExportedHandler<Env> = {
  // --------------------------------------------------------------------------
  // Cron Trigger: re-thread orphaned emails on a schedule
  // Replaces the former /api/rethread HTTP endpoint (issue #31).
  // Runs every 5 minutes; resolves emails flagged with needs_rethreading=1.
  // --------------------------------------------------------------------------
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      resolveOrphanedThreads(env.DB)
        .then((resolved) => {
          if (env.SENTRY_DSN) {
            Sentry.addBreadcrumb({
              category: 'cron.rethread',
              level: 'info',
              message: '[cron/rethread] resolveOrphanedThreads completed',
              data: { resolvedCount: resolved },
            });
          }
        })
        .catch((err) => {
          console.error('[cron/rethread] resolveOrphanedThreads failed:', err);
          if (env.SENTRY_DSN) {
            Sentry.captureException(err, {
              tags: { layer: 'worker', operation: 'cron.rethread' },
            });
          }
        })
    );
  },

  // --------------------------------------------------------------------------
  // Fetch handler: inbound email webhook from Resend
  // --------------------------------------------------------------------------
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // --- Step 0: Verify Cloudflare Access JWT ---
    // This gate MUST precede any resource-consuming operation (rate limiter,
    // D1 reads, R2 writes). Placing it first ensures unauthenticated callers
    // are rejected before touching any metered binding.
    const accessResult = await validateCfAccessJwt(request, env);
    if (!accessResult.ok) {
      console.error('[worker] Cloudflare Access validation failed: ' + accessResult.error);
      return new Response('Unauthorized', { status: 401 });
    }

    // --- Rate limiting (after JWT verification) ---
    // Blocker fix: the rate limiter now fires only after Step 0 (CF Access JWT)
    // so that:
    //   1. Unauthenticated callers cannot drive the metered WEBHOOK_RATE_LIMITER
    //      binding (billing amplification vector).
    //   2. CF-Connecting-IP is used as the key only for verified Cloudflare-
    //      proxied requests, reducing the risk of IP spoofing abuse.
    // Issue 4 fix: log a warning when CF-Connecting-IP is absent so the shared
    // 'unknown' fallback is visible in production logs.
    if (new URL(request.url).pathname === '/api/webhook') {
      const clientIp = request.headers.get('CF-Connecting-IP');
      if (!clientIp) {
        console.warn(
          '[worker] CF-Connecting-IP header absent; rate-limiting under shared key. ' +
          'This may indicate a misconfigured proxy or a non-Cloudflare-proxied request.'
        );
      }
      const rateLimitKey = clientIp ?? 'unknown';
      const { success } = await env.WEBHOOK_RATE_LIMITER.limit({ key: rateLimitKey });
      if (!success) {
        return new Response('Too Many Requests', { status: 429 });
      }
    }

    // Read raw body as text BEFORE any parsing -- required for signature verification
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

    // --- Step 2.1: Validate email_id presence before any dereference ---
    // Guard must fire here — before any await or downstream usage of emailId —
    // so that no code path can dereference a null/undefined emailId.
    const emailId = event.data.email_id;
    if (!emailId) {
      return new Response('Missing email_id', { status: 400 });
    }

    // --- Step 2.5: Duplicate detection — check for existing resend_id in D1 ---
    //
    // SECURITY NOTE: This SELECT executes only after BOTH authentication gates
    // above have passed:
    //   - Step 0: Cloudflare Access JWT validated
    //   - Step 1: Resend svix webhook signature verified
    // Unauthenticated callers are rejected before reaching this point and cannot
    // drive arbitrary D1 reads.
    //
    // RACE CONDITION NOTE: This app-layer check is a fast-path optimisation that
    // avoids unnecessary R2 writes on the common duplicate-delivery case. It does
    // NOT replace the DB-layer race guard. The authoritative idempotency fence is
    // the UNIQUE constraint on `resend_id` in migration 000_init.sql combined with
    // `INSERT OR IGNORE` in Step 8. Two concurrent duplicate deliveries that both
    // pass this SELECT will both attempt the INSERT — the DB constraint ensures
    // exactly one succeeds and the other is silently discarded.
    const existing = await env.DB.prepare(
      'SELECT id FROM emails WHERE resend_id = ? LIMIT 1'
    ).bind(emailId).first();

    if (existing) {
      return new Response('Already ingested', { status: 200 });
    }

    const resend = new Resend(env.RESEND_API_KEY);

    // --- Step 3: Fetch full email payload from Resend Receiving API ---
    // resend v4 types don't yet include emails.receiving; cast through unknown to call it
    // and assert the expected shape so all downstream field accesses are type-checked.
    let receivedEmailPayload: unknown;
    try {
      // Use resend.emails.receiving.get() -- NOT resend.emails.get()
      // resend.emails.get() is for sent mail; receiving.get() is for inbound
      receivedEmailPayload = await (
        resend.emails as unknown as {
          receiving: { get: (id: string) => Promise<unknown> };
        }
      ).receiving.get(emailId);
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
    // The API response is cast from `unknown`; validate the minimum required shape
    // before proceeding so that a malformed API response surfaces immediately as a
    // 502 rather than silently writing nulls into D1.
    const parseResult = parseResendReceivedEmail(receivedEmailPayload);
    if (!parseResult.ok) {
      console.error(
        `[worker] Resend receiving API returned unexpected payload shape: field="${parseResult.field}"`,
        { emailId },
      );
      return new Response('Invalid email payload from upstream', { status: 502 });
    }
    const receivedEmail = parseResult.email;

    // --- Step 4: Threading logic ---
    // Parse headers array for In-Reply-To and Message-ID
    const emailHeaders: Array<{ name: string; value: string }> = receivedEmail.headers ?? [];

    const inReplyTo = emailHeaders.find(
      (h) => h.name.toLowerCase() === 'in-reply-to'
    )?.value ?? null;

    const messageId = emailHeaders.find(
      (h) => h.name.toLowerCase() === 'message-id'
    )?.value ?? null;

    const referencesHeader = (emailHeaders.find(
      (h) => h.name.toLowerCase() === 'references'
    )?.value ?? null)
      // Normalise folded whitespace (CRLF + WSP) into single spaces so
      // downstream consumers receive a clean space-separated Message-ID chain.
      ?.replace(/\s+/g, ' ').trim() ?? null;

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
        // Parent found -- join existing thread
        threadId = parentRow.thread_id;
      } else {
        // Parent not yet received -- use In-Reply-To value as thread_id for now
        // and flag for re-threading once the parent arrives
        threadId = inReplyTo;
        needsRethreading = 1;
        console.warn(`[threading] Parent not found for In-Reply-To: ${inReplyTo}. Flagged for re-threading.`);
      }
    } else {
      // Root message -- start a new thread
      threadId = messageId ?? emailId;
    }

    // --- Step 5: Parse from_name and from_address ---
    // Resend returns from as "Display Name <email@example.com>" or just "email@example.com"
    const { name: fromName, address: fromAddress } = parseFrom(receivedEmail.from ?? '');

    // Guard: a missing or unparseable from field must not silently write an empty
    // string into the NOT NULL from_address column -- reject the webhook instead.
    if (!fromAddress) {
      console.warn('[worker] Received email with missing or unparseable from address; rejecting.', { emailId });
      return new Response('Missing from address', { status: 400 });
    }

    // Normalise `to` to a string regardless of whether the API returns a bare
    // string or an array -- both branches are now handled explicitly.
    const toRaw = receivedEmail.to;
    const toAddress = Array.isArray(toRaw)
      ? toRaw.join(', ')
      : (typeof toRaw === 'string' ? toRaw : '');

    const internalEmailId = crypto.randomUUID();
    const r2Bucket = env.EMAIL_BODIES;

    // --- Step 6: Store body content in R2 and persist key columns in D1 ---
    // R2 write failures are NON-FATAL: we log+warn and proceed with null keys
    // so the D1 INSERT always completes. This prevents the Resend retry
    // contract from creating orphaned R2 objects: if a 500 were returned here,
    // Resend would retry, INSERT OR IGNORE would skip the duplicate resend_id,
    // and any already-written R2 objects would be permanently orphaned.
    let bodyTextKey: string | null = null;
    let bodyHtmlKey: string | null = null;
    if (r2Bucket) {
      if (receivedEmail.text !== null && receivedEmail.text !== undefined) {
        bodyTextKey = getBodyTextKey(internalEmailId);
        try {
          await r2Bucket.put(bodyTextKey, receivedEmail.text, {
            httpMetadata: { contentType: 'text/plain; charset=utf-8' },
          });
        } catch (err) {
          captureR2PutError(err, env, { emailId, operation: 'body_text', objectKey: bodyTextKey });
          bodyTextKey = null;
        }
      }

      if (receivedEmail.html !== null && receivedEmail.html !== undefined) {
        bodyHtmlKey = getBodyHtmlKey(internalEmailId);
        try {
          await r2Bucket.put(bodyHtmlKey, receivedEmail.html, {
            httpMetadata: { contentType: 'text/html; charset=utf-8' },
          });
        } catch (err) {
          captureR2PutError(err, env, { emailId, operation: 'body_html', objectKey: bodyHtmlKey });
          bodyHtmlKey = null;
        }
      }
    } else {
      console.warn('[worker] EMAIL_BODIES R2 bucket not bound; bodies will not be stored in R2', { emailId });
    }

    // --- Step 7: Build attachment descriptor list (download content from Resend) ---
    // Issue 2 fix: R2 attachment puts now happen inside the if (inserted) block
    // in Step 8, after the email INSERT OR IGNORE succeeds. This prevents
    // redundant R2 writes and orphaned objects on duplicate deliveries.
    // Here we only collect the metadata needed to decide what to upload.
    const attachmentsToIngest: Array<{
      safeFilename: string;
      contentType: string;
      attachmentKey: string;
      data: ArrayBuffer | Uint8Array | string | ReadableStream<Uint8Array>;
      estimatedSizeBytes: number;
    }> = [];

    if (r2Bucket) {
      const maxTotalAttachmentBytes = parseAttachmentLimit(env.MAX_TOTAL_ATTACHMENT_BYTES, 25 * 1024 * 1024);
      const maxSingleAttachmentBytes = parseAttachmentLimit(env.MAX_SINGLE_ATTACHMENT_BYTES, 20 * 1024 * 1024);
      let cumulativeAttachmentBytes = 0;
      const attachments = receivedEmail.attachments ?? [];
      for (const [index, attachment] of attachments.entries()) {
        const estimatedSizeBytes = estimateAttachmentBytes(attachment);
        if (estimatedSizeBytes > maxSingleAttachmentBytes) {
          console.warn('[worker] skipping attachment; single-file size limit exceeded', {
            emailId,
            filename: attachment.filename ?? `attachment-${index + 1}`,
            estimatedSizeBytes,
            maxSingleAttachmentBytes,
          });
          continue;
        }

        cumulativeAttachmentBytes += estimatedSizeBytes;
        if (cumulativeAttachmentBytes > maxTotalAttachmentBytes) {
          console.warn('[worker] skipping remaining attachments; cumulative size limit exceeded', {
            emailId,
            cumulativeAttachmentBytes,
            maxTotalAttachmentBytes,
          });
          break;
        }
        const safeFilename = sanitizeAttachmentFilename(
          attachment.filename ?? `attachment-${index + 1}`,
          index
        );
        let attachmentData: ArrayBuffer | Uint8Array | string | ReadableStream<Uint8Array> | null = null;
        try {
          attachmentData = await loadAttachmentContent(
            attachment,
            emailId,
            env.RESEND_API_KEY
          );
        } catch (err) {
          console.warn('[worker] failed to download attachment from Resend', {
            emailId,
            filename: safeFilename,
            error: err,
          });
        }

        if (!attachmentData) {
          console.warn(
            '[worker] skipping attachment; unable to load attachment data',
            { emailId, filename: safeFilename }
          );
          continue;
        }

        const contentType =
          attachment.contentType ??
          attachment.content_type ??
          'application/octet-stream';
        const attachmentKey = `emails/${internalEmailId}/attachments/${safeFilename}`;

        attachmentsToIngest.push({ safeFilename, contentType, attachmentKey, data: attachmentData, estimatedSizeBytes });
      }
    }

    // --- Step 8: Persist metadata + R2 keys to D1 ---
    // INSERT OR IGNORE: Resend guarantees at-least-once delivery, so duplicate
    // webhook deliveries are expected. The UNIQUE constraint on `resend_id`
    // (migration 000_init.sql) combined with IGNORE provides the authoritative
    // DB-layer idempotency fence. The app-layer SELECT in Step 2.5 is a
    // fast-path optimisation that avoids R2 writes on the common duplicate path;
    // this INSERT OR IGNORE is the true race guard for concurrent deliveries.
    //
    // Column order in the INSERT and .bind() are kept in sync.
    try {
      const insertResult = await env.DB.prepare(`
        INSERT OR IGNORE INTO emails
          (id, resend_id, thread_id, from_address, from_name, to_address, subject, body_text, body_html, body_text_key, body_html_key, message_id, in_reply_to, "references", is_read, is_sent, needs_rethreading)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
      `)
        .bind(
          internalEmailId,            // id
          emailId,                    // resend_id
          threadId,                   // thread_id (looked up or new)
          fromAddress,                // from_address
          fromName,                   // from_name (nullable)
          toAddress,                  // to_address
          receivedEmail.subject ?? null,
          null,                       // DEPRECATED: body_text now stored in R2
          null,                       // DEPRECATED: body_html now stored in R2
          bodyTextKey,                // body_text_key
          bodyHtmlKey,                // body_html_key
          messageId,                  // message_id (nullable)
          inReplyTo,                  // in_reply_to (nullable)
          referencesHeader,           // references (nullable)
          needsRethreading,           // needs_rethreading (0 or 1)
        )
        .run();

      // Issue 3 fix: D1Result.meta is typed as always-present; remove the
      // optional chain (?.) that was masking a potential stub misconfiguration
      // where absent meta would silently be treated as a non-duplicate.
      const inserted = (insertResult.meta.changes ?? 0) > 0;
      if (inserted) {
        // Issue 2 fix: R2 attachment writes occur here, inside the inserted gate,
        // so duplicate deliveries never trigger redundant R2 puts.
        const persistedAttachments: Array<{
          r2Key: string;
          filename: string;
          contentType: string | null;
          sizeBytes: number;
          createdAt: number;
        }> = [];

        for (const { safeFilename, contentType, attachmentKey, data, estimatedSizeBytes } of attachmentsToIngest) {
          try {
            await r2Bucket!.put(attachmentKey, data, {
              httpMetadata: { contentType },
            });
            persistedAttachments.push({
              r2Key: attachmentKey,
              filename: safeFilename,
              contentType,
              // Issue 1 fix: use module-level textEncoder instead of per-invocation allocation.
              // For ReadableStream data, byteLength is unavailable so fall back to estimatedSizeBytes.
              sizeBytes: data instanceof ReadableStream
                ? estimatedSizeBytes
                : typeof data === 'string'
                  ? textEncoder.encode(data).byteLength
                  : data.byteLength,
              createdAt: Date.now(),
            });
          } catch (err) {
            console.warn('[worker] failed to persist attachment to R2', {
              emailId,
              filename: safeFilename,
              error: err,
            });
          }
        }

        await Promise.all(persistedAttachments.map(async (attachment) => {
          try {
            await env.DB.prepare(`
              INSERT INTO attachments
                (id, email_id, r2_key, filename, content_type, size_bytes, created_at)
              VALUES
                (?, ?, ?, ?, ?, ?, ?)
            `)
              .bind(
                crypto.randomUUID(),
                internalEmailId,
                attachment.r2Key,
                attachment.filename,
                attachment.contentType,
                attachment.sizeBytes,
                attachment.createdAt,
              )
              .run();
          } catch (err) {
            console.warn('[worker] failed to persist attachment metadata to D1', {
              emailId,
              filename: attachment.filename,
              error: err,
            });
          }
        }));
      }
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
