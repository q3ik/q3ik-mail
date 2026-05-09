-- Migration 001: Add needs_rethreading flag for out-of-order webhook delivery
-- Run with: npx wrangler d1 execute q3ik-mail-db --file=packages/database/migrations/001_add_needs_rethreading.sql

ALTER TABLE emails ADD COLUMN needs_rethreading INTEGER DEFAULT 0;
