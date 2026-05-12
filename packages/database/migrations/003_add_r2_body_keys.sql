-- Migration 003: add R2 object key columns for offloaded email bodies
--
-- DEPRECATED: emails.body_text and emails.body_html are kept temporarily for
-- backward compatibility during the R2 migration rollout. New writes should use
-- body_text_key/body_html_key and store body content in R2.

ALTER TABLE emails ADD COLUMN body_text_key TEXT;
ALTER TABLE emails ADD COLUMN body_html_key TEXT;
