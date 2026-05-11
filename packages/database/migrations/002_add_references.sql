-- Migration 002: Add references column for RFC 2822 References header
-- Run with: npx wrangler d1 execute q3ik-mail-db --file=packages/database/migrations/002_add_references.sql

ALTER TABLE emails ADD COLUMN references TEXT;
