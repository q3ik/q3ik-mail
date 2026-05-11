/**
 * Full email row — mirrors the D1 `emails` table exactly.
 * Used when rendering the reading pane (full body required).
 */
export interface Email {
  id: string;             // UUID primary key
  resend_id: string;      // Resend email_id (unique)
  thread_id: string;      // Shared by all emails in a conversation; set at ingestion
                          // to (root message_id ?? root resend emailId) via In-Reply-To
                          // chain walk in the worker. Never changes after insert.
  from_address: string;   // Sender email address
  from_name: string | null; // Sender display name (nullable)
  to_address: string;     // Recipient(s), comma-separated if multiple. NOT NULL —
                          // worker must supply a non-null value (use '' if unknown)
  subject: string | null;
  body_text: string | null;  // Plain text body
  body_html: string | null;  // Raw HTML — MUST be sanitized before rendering
  message_id: string | null; // RFC 2822 Message-ID header
  in_reply_to: string | null; // RFC 2822 In-Reply-To header
  references: string | null; // RFC 2822 References header (space-separated Message-ID chain)
  is_read: 0 | 1;         // SQLite boolean
  is_sent: 0 | 1;         // 0 = inbound, 1 = outbound
  needs_rethreading: 0 | 1; // 1 if thread_id couldn't be resolved at ingest
  created_at: string;     // ISO 8601 datetime string
}

/**
 * Lightweight projection for inbox list views.
 * Omits body_html and body_text to reduce payload size.
 * Used by getLatestEmails() and list rendering in apps/web.
 */
export type EmailSummary = Omit<Email, 'body_html' | 'body_text'>;

/**
 * Input type for inserting a new inbound email.
 * Omits auto-generated fields (created_at).
 */
export type NewEmail = Omit<Email, 'created_at'>;
