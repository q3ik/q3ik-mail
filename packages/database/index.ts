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
 * results ordered by `ranked_emails.created_at DESC, ranked_emails.resend_id ASC`.
 *
 * Both the inner window ORDER BY and the outer ORDER BY use `resend_id` as the
 * tiebreaker. The cursor encodes `resendId` (the Resend email ID) to match.
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
             -- the outer ORDER BY also uses resend_id as the cursor tiebreaker.
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
       ORDER BY ranked_emails.created_at DESC, ranked_emails.resend_id ASC
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
 * Backfill existing D1-stored body content into R2 and persist key columns.
 * Intended for one-time migration runs after deploying body offload support.
 */
export async function migrateEmailBodiesToR2(
  db: D1Database,
  r2Bucket: R2Bucket,
  limit: number = 100
): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id, body_text, body_html, body_text_key, body_html_key
       FROM emails
       WHERE (body_text IS NOT NULL OR body_html IS NOT NULL)
         AND (body_text_key IS NULL OR body_html_key IS NULL)
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<{
      id: string;
      body_text: string | null;
      body_html: string | null;
      body_text_key: string | null;
      body_html_key: string | null;
    }>();

  let migrated = 0;

  for (const row of results) {
    try {
      let allWritesSucceeded = true;

      const bodyTextKey =
        row.body_text !== null
          ? (row.body_text_key ?? `emails/${row.id}/body.txt`)
          : row.body_text_key;
      const bodyHtmlKey =
        row.body_html !== null
          ? (row.body_html_key ?? `emails/${row.id}/body.html`)
          : row.body_html_key;

      if (row.body_text !== null && row.body_text_key === null && bodyTextKey !== null) {
        await r2Bucket.put(bodyTextKey, row.body_text, {
          httpMetadata: { contentType: 'text/plain; charset=utf-8' },
        });
        const bodyTextHead = await r2Bucket.head(bodyTextKey);
        if (!bodyTextHead) {
          const errorMsg = `R2 write verification failed for email ${row.id}, key: ${bodyTextKey}. Skipping email; D1 body columns remain unchanged.`;
          console.error(errorMsg);
          captureR2ReadError(new Error(errorMsg), { operation: 'r2.head.verify', key: bodyTextKey });
          allWritesSucceeded = false;
        }
      }

      if (
        allWritesSucceeded &&
        row.body_html !== null &&
        row.body_html_key === null &&
        bodyHtmlKey !== null
      ) {
        await r2Bucket.put(bodyHtmlKey, row.body_html, {
          httpMetadata: { contentType: 'text/html; charset=utf-8' },
        });
        const bodyHtmlHead = await r2Bucket.head(bodyHtmlKey);
        if (!bodyHtmlHead) {
          const errorMsg = `R2 write verification failed for email ${row.id}, key: ${bodyHtmlKey}. Skipping email; D1 body columns remain unchanged.`;
          console.error(errorMsg);
          captureR2ReadError(new Error(errorMsg), { operation: 'r2.head.verify', key: bodyHtmlKey });
          allWritesSucceeded = false;
        }
      }

      if (!allWritesSucceeded) continue;

      const clearBodyText = bodyTextKey !== null && row.body_text !== null;
      const clearBodyHtml = bodyHtmlKey !== null && row.body_html !== null;

      await db
        .prepare(
          `UPDATE emails
           SET body_text = CASE WHEN ? = 1 THEN NULL ELSE body_text END,
               body_html = CASE WHEN ? = 1 THEN NULL ELSE body_html END,
               body_text_key = COALESCE(?, body_text_key),
               body_html_key = COALESCE(?, body_html_key)
           WHERE id = ?`
        )
        .bind(
          clearBodyText ? 1 : 0,
          clearBodyHtml ? 1 : 0,
          bodyTextKey,
          bodyHtmlKey,
          row.id
        )
        .run();

      migrated++;
    } catch (err) {
      console.warn('[migrateEmailBodiesToR2] failed to migrate row', {
        emailId: row.id,
        error: err,
      });
    }
  }

  return migrated;
}

/**
 * Fetch all distinct thread root emails for inbox view.
 * Returns one representative email per thread (the most recent by created_at).
 * Ties on created_at are broken by resend_id for a stable, deterministic order.
 * Useful for rendering a deduplicated thread list.
 *
 * @param db    - D1Database binding
 * @param limit - Max threads to return (default: 50)
 */
export async function getThreadList(
  db: D1Database,
  limit: number = 50
): Promise<EmailSummary[]> {
  const { sql, params } = buildThreadListQuery({ limit });
  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<EmailSummary>();
  return results;
}

export async function searchEmails(
  db: D1Database,
  query: string
): Promise<EmailSummary[]> {
  const trimmedQuery = query.trim();
  if (query.length > 1000 || !trimmedQuery || trimmedQuery.length > 500) return [];

  const terms = trimmedQuery
    .split(/\s+/)
    .filter(Boolean)
    // Only escape double-quote characters for FTS5 phrase quoting.
    // All other characters (hyphens, colons, etc.) are valid inside a
    // double-quoted FTS5 phrase and must not be stripped.
    .map((term) => term.replace(/"/g, '""'))
    .filter(Boolean);

  if (terms.length === 0) return [];

  // Use implicit AND (space-separated phrases) so that multi-word queries
  // require all terms to be present. OR would match any single word and
  // produces over-broad, low-quality results.
  const matchQuery = terms.map((term) => `"${term}"`).join(' ');

  const { results } = await db
    .prepare(
      `SELECT
         id, resend_id, thread_id, from_address, from_name,
         to_address, subject, message_id, in_reply_to, "references",
         is_read, is_sent, needs_rethreading, created_at
       FROM (
         SELECT
           emails.id, emails.resend_id, emails.thread_id, emails.from_address, emails.from_name,
           emails.to_address, emails.subject, emails.message_id, emails.in_reply_to, emails."references",
           emails.is_read, emails.is_sent, emails.needs_rethreading, emails.created_at,
           ROW_NUMBER() OVER (
             PARTITION BY emails.thread_id
             ORDER BY bm25(emails_fts), emails.created_at DESC, emails.id ASC
           ) AS thread_rank,
           bm25(emails_fts) AS rank
         FROM emails
         JOIN emails_fts ON emails.rowid = emails_fts.rowid
         WHERE emails_fts MATCH ?
       ) ranked_results
       WHERE thread_rank = 1
       ORDER BY rank ASC, created_at DESC, id ASC
       LIMIT 50`
    )
    .bind(matchQuery)
    .all<EmailSummary>();

  return results;
}

export async function getThreadListPage(
  db: D1Database,
  {
    limit = 50,
    cursor,
  }: {
    limit?: number;
    cursor?: string;
  } = {}
): Promise<ThreadListPage> {
  const pageSize = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
  const fetchLimit = pageSize + 1;
  let decodedCursor: ThreadListCursorPayload | null = null;
  if (cursor) {
    try {
      decodedCursor = decodeThreadListCursor(cursor);
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return { threads: [], nextCursor: null };
      }
      if (err instanceof StaleVersionError) {
        // v1 cursor from before the resend_id tiebreaker migration — restart
        // pagination from the first page rather than returning an empty result.
        decodedCursor = null;
      } else {
        throw err;
      }
    }
  }
  const { sql, params } = buildThreadListQuery({
    cursor: decodedCursor,
    limit: fetchLimit,
  });
  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<EmailSummary>();

  const threads = results.slice(0, pageSize);
  const lastThread = threads.at(-1);
  const nextCursor =
    results.length > pageSize && lastThread
      ? encodeThreadListCursor({
          v: 2,
          createdAt: lastThread.created_at,
          resendId: lastThread.resend_id,
        })
      : null;

  return {
    threads,
    nextCursor,
  };
}

/**
 * Re-threading sweep: finds emails flagged with needs_rethreading=1
 * and attempts to resolve their thread_id by looking up the parent.
 *
 * This is intended to be called:
 * - Manually via a Cloudflare Worker Cron Trigger (future)
 * - Via a debug API route for immediate recovery
 *
 * @param db - D1Database binding
 * @returns number of emails successfully re-threaded
 */
export async function resolveOrphanedThreads(db: D1Database): Promise<number> {
  const D1_SAFE_IN_BIND_LIMIT = 90;

  // Fetch a single bounded batch of orphaned emails and only resolve them via
  // RFC 2822 Message-ID lookup. If the parent still does not exist, leave the
  // orphan on its current thread_id so it is not silently merged by subject.
  const { results: orphans } = await db
    .prepare(
      `SELECT id, in_reply_to, "references"
       FROM emails
       WHERE needs_rethreading = 1
          AND in_reply_to IS NOT NULL
        ORDER BY created_at ASC
        LIMIT ?`
    )
    .bind(ORPHAN_RETHREAD_BATCH_SIZE)
    .all<{ id: string; in_reply_to: string; references: string | null }>();

  // Nothing to do — skip the bulk SELECT and batch entirely.
  if (orphans.length === 0) return 0;

  const parentMessageIds = [...new Set(orphans.map((orphan) => orphan.in_reply_to))];
  const inReplyToPlaceholders = parentMessageIds.map(() => '?').join(', ');
  const { results: parentCandidates } =
    parentMessageIds.length > 0
      ? await db
          .prepare(
            `SELECT id, message_id, thread_id
             FROM emails
             WHERE message_id IN (${inReplyToPlaceholders})`
          )
          .bind(...parentMessageIds)
          .all<{ id: string; message_id: string; thread_id: string }>()
      : { results: [] };

  const parentMap = new Map(
    parentCandidates.map((parent) => [parent.message_id, parent] as const
  ));
  const allReferenceIds = new Set<string>();

  for (const orphan of orphans) {
    if (parentMap.has(orphan.in_reply_to) || !orphan.references) continue;

    for (const ref of orphan.references.trim().split(/\s+/)) {
      if (ref && !parentMap.has(ref)) allReferenceIds.add(ref);
    }
  }

  const referenceMap = new Map<
    string,
    {
      id: string;
      thread_id: string;
    }
  >();

  if (allReferenceIds.size > 0) {
    const referenceIds = [...allReferenceIds];

    for (let start = 0; start < referenceIds.length; start += D1_SAFE_IN_BIND_LIMIT) {
      const chunk = referenceIds.slice(start, start + D1_SAFE_IN_BIND_LIMIT);
      const placeholders = chunk.map(() => '?').join(', ');
      const { results: referenceCandidates } = await db
        .prepare(
          `SELECT id, message_id, thread_id
           FROM emails
           WHERE message_id IN (${placeholders})`
        )
        .bind(...chunk)
        .all<{ id: string; message_id: string; thread_id: string }>();

      for (const referenceCandidate of referenceCandidates) {
        referenceMap.set(referenceCandidate.message_id, referenceCandidate);
      }
    }
  }

  const updates: D1PreparedStatement[] = [];

  for (const orphan of orphans) {
    let parent:
      | {
          id: string;
          thread_id: string;
        }
      | null = parentMap.get(orphan.in_reply_to) ?? null;

    if (!parent && orphan.references) {
      const refs = orphan.references.trim().split(/\s+/).reverse();
      for (const ref of refs) {
        const ancestor = referenceMap.get(ref) ?? parentMap.get(ref);
        if (ancestor) {
          parent = ancestor;
          break;
        }
      }
    }

    if (!parent) continue; // Parent still hasn't arrived

    updates.push(
      db
        .prepare(
          `UPDATE emails
           SET thread_id = ?, needs_rethreading = 0
           WHERE id = ? AND needs_rethreading = 1`
        )
        .bind(parent.thread_id, orphan.id)
    );
  }

  if (updates.length > 0) {
    await db.batch(updates);
  }

  const resolvedCount = updates.length;

  if (resolvedCount > 0) {
    console.log(`[rethread] resolved ${resolvedCount} orphaned rows`);
  }

  return resolvedCount;
}
