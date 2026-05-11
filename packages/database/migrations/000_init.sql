-- Migration 000: Initial schema — emails table and indexes
-- Applied automatically via: npx wrangler d1 migrations apply q3ik-mail-db
-- (run from the apps/worker directory, or any directory containing a wrangler.toml
--  that declares this migrations_dir)

CREATE TABLE IF NOT EXISTS emails (
  id           TEXT PRIMARY KEY,                     -- UUID
  resend_id    TEXT UNIQUE NOT NULL,                 -- ID from Resend API
  thread_id    TEXT NOT NULL,                        -- Grouped by Conversation
  from_address TEXT NOT NULL,
  from_name    TEXT,
  to_address   TEXT NOT NULL,
  subject      TEXT,
  body_text    TEXT,
  body_html    TEXT,
  message_id   TEXT UNIQUE,                          -- Header Message-ID for threading
  in_reply_to  TEXT,                                 -- Reference for threading
  is_read      INTEGER DEFAULT 0,                    -- Boolean (0 = unread, 1 = read)
  is_sent      INTEGER DEFAULT 0,                    -- 0 = inbound, 1 = outbound
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_emails_thread_id ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_created_at ON emails(created_at);
