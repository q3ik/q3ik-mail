-- Migration 006: add composite index for thread-list window pagination

CREATE INDEX IF NOT EXISTS idx_emails_thread_list
  ON emails(thread_id, created_at DESC, resend_id ASC);

-- Drop redundant single-column index
DROP INDEX IF EXISTS idx_emails_thread_id;
