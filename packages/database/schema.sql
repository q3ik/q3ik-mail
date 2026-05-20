-- Reference schema — mirrors the cumulative result of all applied migrations.
-- This file is kept as human-readable documentation and for tooling that reads
-- the schema directly (e.g. DB GUIs, type generators).
-- The canonical source of truth for the live database is the numbered migration
-- files in packages/database/migrations/ (applied in order).
-- Do NOT apply this file directly to D1 — use:
--   cd apps/worker && npx wrangler d1 migrations apply q3ik-mail-db --local

-- Table for storing individual email messages
CREATE TABLE IF NOT EXISTS emails (
  id                TEXT PRIMARY KEY,                     -- UUID
  resend_id         TEXT UNIQUE NOT NULL,                 -- ID from Resend API
  thread_id         TEXT NOT NULL,                        -- Grouped by Conversation
  from_address      TEXT NOT NULL,
  from_name         TEXT,
  to_address        TEXT NOT NULL,
  subject           TEXT,
  body_text         TEXT,                                 -- DEPRECATED: use body_text_key + R2
  body_html         TEXT,                                 -- DEPRECATED: use body_html_key + R2
  body_text_key     TEXT,                                 -- R2 object key, e.g. emails/{id}/body.txt
  body_html_key     TEXT,                                 -- R2 object key, e.g. emails/{id}/body.html
  message_id        TEXT UNIQUE,                          -- RFC 2822 Message-ID header
  in_reply_to       TEXT,                                 -- RFC 2822 In-Reply-To header
  "references"      TEXT,                                 -- RFC 2822 References header (space-separated Message-ID chain)
                                                          -- NOTE: no index added yet — column is stored only, not queried.
                                                          -- Add idx_emails_references if thread-reconstruction queries land.
  is_read           INTEGER NOT NULL DEFAULT 0,           -- Boolean (0 = unread, 1 = read)
  is_sent           INTEGER NOT NULL DEFAULT 0,           -- 0 = inbound, 1 = outbound
  needs_rethreading INTEGER NOT NULL DEFAULT 0,           -- 1 if thread_id couldn't be resolved at ingest
  status            TEXT NOT NULL DEFAULT 'received',     -- 'received' | 'pending_send' | 'sent' | 'send_failed'
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for fast inbox loading and threading lookups
CREATE INDEX IF NOT EXISTS idx_emails_created_at ON emails(created_at);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
CREATE INDEX IF NOT EXISTS idx_emails_thread_list
  ON emails(thread_id, created_at DESC, resend_id ASC);

-- Optional: Table for simple contact management
CREATE TABLE IF NOT EXISTS contacts (
  email TEXT PRIMARY KEY,
  name TEXT,
  last_contacted DATETIME
);
