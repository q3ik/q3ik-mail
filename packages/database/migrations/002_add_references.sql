-- Migration 002: Add "references" column for RFC 2822 References header
-- Run with: npx wrangler d1 execute q3ik-mail-db --file=packages/database/migrations/002_add_references.sql
--
-- IMPORTANT: SQLite does not support ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
-- This migration must only be applied once against a database initialised from
-- schema versions that do NOT already contain the "references" column (i.e.
-- databases created before this migration). Applying it twice will produce a
-- "duplicate column name" error. Use a migration tracking table or Wrangler's
-- --experimental-versions flag to prevent double-application in CI.

ALTER TABLE emails ADD COLUMN "references" TEXT;
