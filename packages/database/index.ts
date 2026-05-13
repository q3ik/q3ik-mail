import type { Email, EmailSummary } from './types';

export type { Email, EmailSummary, NewEmail } from './types';

/**
 * Reads a body string from R2 by key.
 *
 * - Returns `fallbackBody` when `key` is null (no R2 key stored yet).
 * - Returns `fallbackBody` when the R2 object is missing, and logs a warning
 *   so key/object mismatches are detectable in production logs.
 * - Errors are NOT swallowed here; callers should handle them individually.
 */
async function readBodyFromR2(
  r2Bucket: R2Bucket,
  key: string | null,
  fallbackBody: string | null
): Promise<string | null> {
  if (!key) return fallbackBody;
  const object = await r2Bucket.get(key);
  if (!object) {
    console.warn('[database] R2 object not found for key; falling back to D1 value', { key });
    return fallbackBody;
  }
  return object.text();
}

/**
 * Captures an R2 read failure to Sentry via the globalThis hook.
 * Encapsulates the globalThis type assertion and optional chaining so
 * individual catch blocks stay clean.
 */
function captureR2ReadError(
  err: unknown,
  ctx: { operation: string; key: string | null },
): void {
  const sentryCapture = (
    globalThis as { Sentry?: { captureException?: (error: unknown, context?: unknown) => void } }
  ).Sentry?.captureException;
  if (!sentryCapture) return;

  const tags: Record<string, string> = {
    layer: 'database',
    storage_provider: 'r2',
    operation: ctx.operation,
  };
  if (ctx.key) tags.r2_object_key = ctx.key;

  sentryCapture(err, { tags });
}

/**
 * Hydrates body_html and body_text on an Email from R2 when key columns are set.
 *
 * Each R2 read failure is caught individually so one transient error does not
 * fail the entire result set. Failed reads fall back to the D1 column value
 * (which is null for new records).
 */
async function hydrateEmailBodyFromR2(
  email: Email,
  r2Bucket: R2Bucket | null | undefined
): Promise<Email> {
  if (!r2Bucket) return email;

  const [bodyHtml, bodyText] = await Promise.all([
    readBodyFromR2(r2Bucket, email.body_html_key, email.body_html).catch((err) => {
      console.warn('[database] R2 read failed for body_html; using fallback', { key: email.body_html_key, err });
      captureR2ReadError(err, { operation: 'r2.get.body_html', key: email.body_html_key });
      return email.body_html;
    }),
    readBodyFromR2(r2Bucket, email.body_text_key, email.body_text).catch((err) => {
      console.warn('[database] R2 read failed for body_text; using fallback', { key: email.body_text_key, err });
      captureR2ReadError(err, { operation: 'r2.get.body_text', key: email.body_text_key });
      return email.body_text;
    }),
  ]);

  return {
    ...email,
    body_html: bodyHtml,
    body_text: bodyText,
  };
}

export interface ThreadListPage {
  threads: EmailSummary[];
  nextCursor: string | null;
}

interface ThreadListCursorPayload {
  v: 2;
  createdAt: string;
  resendId: string;
}

function encodeThreadListCursor(cursor: ThreadListCursorPayload): string {
  return btoa(JSON.stringify(cursor));
}

class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

/**
 * Thrown when a cursor was encoded with an older payload shape (v1: { createdAt, id }).
 * The caller should restart pagination from the beginning rather than returning an empty page.
 */
class StaleVersionError extends Error {
  constructor() {
    super('Stale cursor version; restart pagination from the beginning');
    this.name = 'StaleVersionError';
  }
}

function decodeThreadListCursor(cursor: string): ThreadListCursorPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(atob(cursor));
  } catch {
    throw new InvalidCursorError('Invalid thread list cursor');
  }

  if (!payload || typeof payload !== 'object') {
    throw new InvalidCursorError('Invalid thread list cursor');
  }

  const p = payload as Record<string, unknown>;

  // Detect v1 shape: { createdAt, id } with no version field.
  // These are in-flight cursors from before the resend_id tiebreaker migration.
  if (typeof p.createdAt === 'string' && typeof p.id === 'string' && !('resendId' in p)) {
    throw new StaleVersionError();
  }

  if (p.v !== 2 || typeof p.createdAt !== 'string' || typeof p.resendId !== 'string') {
    throw new InvalidCursorError('Invalid thread list cursor');
  }

  return { v: 2, createdAt: p.createdAt, resendId: p.resendId };
}

/**
 * Builds the ranked thread list SQL and bind parameters shared by
 * {@link getThreadList} and {@link getThreadListPage}.
 *
 * The inner subquery assigns `thread_rank = 1` to the most-recent email in
 * each thread (window ordered by `created_at DESC, resend_id ASC` for a
 * stable per-thread tiebreaker). The outer query filters to rank-1 rows,
 * applies an optional cursor predicate for keyset pagination, and returns
 * results ordered by `ranked_emails.created_at DESC, ranked_emails.id ASC`.
 *
 * @param opts.cursor - Optional keyset cursor; when present adds the composite
 *                      `(ranked_emails.created_at < ?) OR
 *                      (ranked_emails.created_at = ? AND ranked_emails.resend_id > ?)`
 *                      predicate. The `resendId` field of the cursor is the
 *                      Resend email ID, matching the outer `ORDER BY` tiebreaker.
 * @param opts.limit  - Number of rows to fetch (callers add +1 for has-next-page
 *                      detection when needed).
 */
function buildThreadListQuery(opts: {
  cursor?: ThreadListCursorPayload | null;
  limit: number;
}): { sql: string; params: (string | number)[] } {
  const rankedSubquery = `SELECT
           id, resend_id, thread_id, from_address, from_name,
           to_address, subject, message_id, in_reply_to, "references",
           is_read, is_sent, needs_rethreading, created_at,
           ROW_NUMBER() OVER (
             PARTITION BY thread_id
             -- resend_id breaks ties within a thread to pick the representative row;
             -- the outer ORDER BY uses resend_id as the cursor tiebreaker.
             ORDER BY created_at DESC, resend_id ASC
           ) AS thread_rank
         FROM emails`;

  const whereClause = opts.cursor
    ? `WHERE thread_rank = 1
         AND (
           ranked_emails.created_at < ?
           OR (ranked_emails.created_at = ? AND ranked_emails.resend_id > ?)
         )`
    : 'WHERE thread_rank = 1';

  const sql = `SELECT
         id, resend_id, thread_id, from_address, from_name,
         to_address, subject, message_id, in_reply_to, "references",
         is_read, is_sent, needs_rethreading, created_at
       FROM (
         ${rankedSubquery}
       ) ranked_emails
       ${whereClause}
       ORDER BY ranked_emails.created_at DESC, ranked_emails.id ASC
       LIMIT ?`;

  const params: (string | number)[] = opts.cursor
    ? [opts.cursor.createdAt, opts.cursor.createdAt, opts.cursor.resendId, opts.limit]
    : [opts.limit];

  return { sql, params };
}

const ORPHAN_RETHREAD_BATCH_SIZE = 100;

/**
 * Fetch the N most recent emails ordered by created_at DESC.
 * Returns EmailSummary (no body fields) for efficient list rendering.
 *
 * @param db    - D1Database binding injected from the Cloudflare runtime env
 * @param limit - Max number of emails to return (default: 50)
 */
export async function getLatestEmails(
  db: D1Database,
  limit: number = 50
): Promise<EmailSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT
         id, resend_id, thread_id, from_address, from_name,
         to_address, subject, message_id, in_reply_to, "references",
         is_read, is_sent, needs_rethreading, created_at
       FROM emails
       ORDER BY created_at DESC, resend_id ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<EmailSummary>();
  return results;
}

/**
 * Fetch all emails in a thread, ordered chronologically (oldest first).
 * Returns full Email objects including body_html and body_text.
 * Caller is responsible for sanitizing body_html before rendering.
 *
 * Threading invariant: all emails in a conversation share the same thread_id.
 * The worker sets thread_id = (root message's message_id ?? root resend emailId)
 * by walking up In-Reply-To chains at ingestion time (see apps/worker/src/index.ts).
 * Never use resend_id directly as a thread lookup key.
 *
 * @param db       - D1Database binding
 * @param threadId - The thread_id shared by all emails in the conversation
 */
export async function getEmailsByThread(
  db: D1Database,
  threadId: string,
  r2Bucket: R2Bucket | null = null
): Promise<Email[]> {
  const { results } = await db
    .prepare(
      `SELECT *
       FROM emails
       WHERE thread_id = ?
       ORDER BY created_at ASC, resend_id ASC`
    )
    .bind(threadId)
    .all<Email>();

  return Promise.all(results.map((email) => hydrateEmailBodyFromR2(email, r2Bucket)));
}

/**
 * Mark a single email as read.
 * Uses the internal UUID `id`, not resend_id.
 *
 * @param db      - D1Database binding
 * @param emailId - The UUID primary key of the email (emails.id)
 */
export async function markAsRead(
  db: D1Database,
  emailId: string
): Promise<void> {
  await db
    .prepare(`UPDATE emails SET is_read = 1 WHERE id = ?`)
    .bind(emailId)
    .run();
}

/**
 * Fetch a single email by its internal UUID.
 * Returns null if not found.
 *
 * @param db      - D1Database binding
 * @param emailId - The UUID primary key (emails.id)
 */
export async function getEmailById(
  db: D1Database,
  emailId: string,
  r2Bucket: R2Bucket | null = null
): Promise<Email | null> {
  const result = await db
    .prepare(`SELECT * FROM emails WHERE id = ? LIMIT 1`)
    .bind(emailId)
    .first<Email>();
  if (!result) return null;
  return hydrateEmailBodyFromR2(result, r2Bucket);
}

/**
 * Backfill existing D1-store