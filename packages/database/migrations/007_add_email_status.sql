-- Migration 007: Add status column for outbox send state machine
--
-- Values: 'received' (inbound), 'pending_send' (intent persisted, not yet sent),
--         'sent' (Resend accepted), 'send_failed' (Resend rejected).
--
-- All existing rows default to 'received', which is correct — every row in the
-- table before this migration was either an inbound email or a successfully
-- persisted outbound email. Outbound rows keep is_sent=1 as the direction flag;
-- status tracks the delivery lifecycle.

ALTER TABLE emails ADD COLUMN status TEXT NOT NULL DEFAULT 'received';
