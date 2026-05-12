import type { Email, EmailSummary } from './types';

export type { Email, EmailSummary, NewEmail } from './types';

export interface ThreadListPage {
  threads: EmailSummary[];
  nextCursor: string | null;
}

interface ThreadListCursorPayload {
  createdAt: string;
  id: string;
}

function encodeThreadListCursor(cursor: ThreadListCursorPayload): string {
  return btoa(JSON.stringify(cursor));
}

function decodeThreadListCursor(cursor: string): ThreadListCursorPayload {
  const payload = JSON.parse(atob(cursor)) as Partial<ThreadListCursorPayload>;

  if (typeof payload.createdAt !== 'string' || typeof payload.id !== 'string') {
    throw new Error('Invalid thread list cursor');
  }

  return {
    createdAt: payload.createdAt,
    id: payload.id,
  };
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
       ORDER BY created_at DESC, id ASC
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
  threadId: string
): Promise<Email[]> {
  const { results } = await db
    .prepare(
      `SELECT *
       FROM emails
       WHERE thread_id = ?
       ORDER BY created_at ASC, id ASC`
    )
    .bind(threadId)
    .all<Email>();
  return results;
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
  emailId: string
): Promise<Email | null> {
  const result = await db
    .prepare(`SELECT * FROM emails WHERE id = ? LIMIT 1`)
    .bind(emailId)
    .first<Email>();
  return result ?? null;
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
  const { results } = await db
    .prepare(
      `SELECT
         id, resend_id, thread_id, from_address, from_name,
         to_address, subject, message_id, in_reply_to, "references",
         is_read, is_sent, needs_rethreading, created_at
       FROM (
         SELECT
           id, resend_id, thread_id, from_address, from_name,
           to_address, subject, message_id, in_reply_to, "references",
           is_read, is_sent, needs_rethreading, created_at,
           ROW_NUMBER() OVER (
             PARTITION BY thread_id
             ORDER BY created_at DESC, resend_id ASC
           ) AS thread_rank
         FROM emails
       ) ranked_emails
       WHERE thread_rank = 1
       ORDER BY created_at DESC, id ASC
       LIMIT ?`
    )
    .bind(limit)
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
  const decodedCursor = cursor ? decodeThreadListCursor(cursor) : null;
  const whereClause = decodedCursor
    ? `WHERE thread_rank = 1
         AND (
           created_at < ?
           OR (created_at = ? AND id > ?)
         )`
    : 'WHERE thread_rank = 1';
  const sql = `SELECT
                 id, resend_id, thread_id, from_address, from_name,
                 to_address, subject, message_id, in_reply_to, "references",
                 is_read, is_sent, needs_rethreading, created_at
               FROM (
                 SELECT
                   id, resend_id, thread_id, from_address, from_name,
                   to_address, subject, message_id, in_reply_to, "references",
                   is_read, is_sent, needs_rethreading, created_at,
                   ROW_NUMBER() OVER (
                     PARTITION BY thread_id
                     ORDER BY created_at DESC, resend_id ASC
                   ) AS thread_rank
                 FROM emails
               ) ranked_emails
               ${whereClause}
               ORDER BY created_at DESC, id ASC
               LIMIT ?`;
  const bindArgs = decodedCursor
    ? [
        decodedCursor.createdAt,
        decodedCursor.createdAt,
        decodedCursor.id,
        fetchLimit,
      ]
    : [fetchLimit];
  const { results } = await db
    .prepare(sql)
    .bind(...bindArgs)
    .all<EmailSummary>();

  const threads = results.slice(0, pageSize);
  const lastThread = threads.at(-1);
  const nextCursor =
    results.length > pageSize && lastThread
      ? encodeThreadListCursor({
          createdAt: lastThread.created_at,
          id: lastThread.id,
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
  // Fetch a single bounded batch of orphaned emails and only resolve them via
  // RFC 2822 Message-ID lookup. If the parent still does not exist, leave the
  // orphan on its current thread_id so it is not silently merged by subject.
  const { results: orphans } = await db
    .prepare(
      `SELECT id, in_reply_to
       FROM emails
       WHERE needs_rethreading = 1
          AND in_reply_to IS NOT NULL
        ORDER BY created_at ASC
        LIMIT ?`
    )
    .bind(ORPHAN_RETHREAD_BATCH_SIZE)
    .all<{ id: string; in_reply_to: string }>();

  let resolvedCount = 0;

  for (const orphan of orphans) {
    // Look up the parent by its message_id
    const parent = await db
      .prepare('SELECT thread_id FROM emails WHERE message_id = ? LIMIT 1')
      .bind(orphan.in_reply_to)
      .first<{ thread_id: string }>();

    if (!parent) continue; // Parent still hasn't arrived

    // Update the orphan's thread_id and clear the flag
    await db
      .prepare(
        `UPDATE emails
         SET thread_id = ?, needs_rethreading = 0
         WHERE id = ?`
      )
      .bind(parent.thread_id, orphan.id)
      .run();

    resolvedCount++;
  }

  if (resolvedCount > 0) {
    console.log(`[rethread] resolved ${resolvedCount} orphaned rows`);
  }

  return resolvedCount;
}
