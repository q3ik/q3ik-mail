-- Migration 003: Add FTS5 index for email search
-- Keeps emails_fts synchronized with emails via INSERT/UPDATE/DELETE triggers.

CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
  subject,
  body_text,
  from_address,
  from_name,
  content='emails',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS emails_ai AFTER INSERT ON emails BEGIN
  INSERT INTO emails_fts(rowid, subject, body_text, from_address, from_name)
  VALUES (new.rowid, new.subject, new.body_text, new.from_address, new.from_name);
END;

CREATE TRIGGER IF NOT EXISTS emails_ad AFTER DELETE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, body_text, from_address, from_name)
  VALUES ('delete', old.rowid, old.subject, old.body_text, old.from_address, old.from_name);
END;

CREATE TRIGGER IF NOT EXISTS emails_au AFTER UPDATE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, body_text, from_address, from_name)
  VALUES ('delete', old.rowid, old.subject, old.body_text, old.from_address, old.from_name);
  INSERT INTO emails_fts(rowid, subject, body_text, from_address, from_name)
  VALUES (new.rowid, new.subject, new.body_text, new.from_address, new.from_name);
END;

-- Backfill existing rows into the FTS index.
-- Guard prevents duplicate entries if this migration is applied more than once
-- (e.g. during local dev resets or accidental Wrangler re-runs).
INSERT INTO emails_fts(rowid, subject, body_text, from_address, from_name)
SELECT rowid, subject, body_text, from_address, from_name
FROM emails
WHERE NOT EXISTS (SELECT 1 FROM emails_fts LIMIT 1);
