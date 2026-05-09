import type { Email, EmailSummary } from './types';

export type { Email, EmailSummary, NewEmail } from './types';

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
         to_address, subject, message_id, in_reply_to,
         is_read, is_sent, created_at
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
         to_address, subject, message_id, in_reply_to,
         is_read, is_sent, created_at
       FROM (
         SELECT
           id, resend_id, thread_id, from_address, from_name,
           to_address, subject, message_id, in_reply_to,
           is_read, is_sent, created_at,
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
