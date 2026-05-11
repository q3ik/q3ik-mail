-- Table for storing individual email messages
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,               -- UUID
  resend_id TEXT UNIQUE NOT NULL,    -- ID from Resend API
  thread_id TEXT NOT NULL,           -- Grouped by Conversation
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_address TEXT NOT NULL,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  message_id TEXT UNIQUE,            -- Header Message-ID for threading
  in_reply_to TEXT,                  -- Reference for threading
  is_read INTEGER DEFAULT 0,         -- Boolean (0 or 1)
  is_sent INTEGER DEFAULT 0,         -- Distinguish inbound vs outbound
  needs_rethreading INTEGER DEFAULT 0, -- 1 if thread_id couldn't be resolved at ingest
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexing for fast inbox loading
CREATE INDEX IF NOT EXISTS idx_emails_thread_id ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_created_at ON emails(created_at);

-- Optional: Table for simple contact management
CREATE TABLE IF NOT EXISTS contacts (
  email TEXT PRIMARY KEY,
  name TEXT,
  last_contacted DATETIME
);
