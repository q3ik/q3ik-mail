-- Migration 000: Initial schema — emails table and indexes
-- Applied automatically via: npx wrangler d1 migrations apply q3ik-mail-db
-- (run from the apps/worker directory, or any directory containing a wrangler.toml
--  that declares this migrations_dir)
-- NOTE: No standalone 001_* migration file exists in this repository.
-- During early schema consolidation (PR #139, 2026-05-13), its history was kept in 000_init.sql.

CREATE TABLE IF NOT EXISTS emails (
  id                TEXT PRIMARY KEY,                     -- UUID
  resend_id         TEXT UNIQUE NOT NULL,                 -- ID from Resend API
  thread_id         TEXT NOT NULL,                        -- Grouped by Conversation
  from_address      TEXT NOT NULL,
  from_name         TEXT,
  to_address        TEXT NOT NULL,
  subject           TEXT,
  body_text         TEXT,
  body_html         TEXT,
  message_id        TEXT UNIQUE,                          -- RFC 2822 Message-ID header
  in_reply_to       TEXT,                                 -- RFC 2822 In-Reply-To header
  is_read           INTEGER NOT NULL DEFAULT 0,           -- Boolean (0 = unread, 1 = read)
  is_sent           INTEGER NOT NULL DEFAULT 0,           -- 0 = inbound, 1 = outbound
  needs_rethreading INTEGER NOT NULL DEFAULT 0,           -- 1 if thread_id couldn't be resolved at ingest
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_emails_thread_id  ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_created_at ON emails(created_at);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
