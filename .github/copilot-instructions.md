# Copilot Cloud Agent Onboarding (q3ik-mail)

## Quick repo map
- Monorepo managed by `pnpm` workspaces + Turborepo.
- Apps:
  - `apps/web`: Next.js App Router UI + API routes (Cloudflare/OpenNext target).
  - `apps/worker`: Cloudflare Worker for inbound webhook ingestion + scheduled rethreading.
- Packages:
  - `packages/database`: D1 schema, migrations, typed query helpers, tests.
  - `packages/emails`: React email templates.
  - `packages/testing`: shared test helpers.
  - `packages/ts-config`: shared TS configs.

## First-time setup
1. Use Node 20+.
2. From repo root: `corepack enable` (important so plain `pnpm` is available to subprocesses).
3. Install deps: `corepack pnpm install`.

## Fast workflow for changes
- Prefer targeted workspace commands instead of root-wide runs.
- Common validation commands used in CI:
  - Worker: `pnpm --filter @q3ik-mail/worker typecheck && pnpm --filter @q3ik-mail/worker lint && pnpm --filter @q3ik-mail/worker test`
  - Database: `pnpm --filter @q3ik-mail/database typecheck && pnpm --filter @q3ik-mail/database test`
  - Web: `pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web test`
  - Cloudflare web build: `pnpm --filter web run build:cf`

## D1 + migrations rules
- Keep migration files in `packages/database/migrations`.
- Worker `wrangler.toml` sets `migrations_dir = "../../packages/database/migrations"`; run migration apply commands from `apps/worker`.
- `apps/web/wrangler.toml` and `apps/worker/wrangler.toml` contain `database_id = "REPLACE_WITH_YOUR_DATABASE_ID"` placeholder; CI injects this at runtime. Do not commit replaced IDs.
- `000_init.sql` intentionally contains squashed early migration history.

## Test/CI behavior to align with
- CI pipeline: config guard → typecheck → lint → migration validation → unit tests → e2e.
- E2E app startup is managed by Playwright `webServer` in `apps/web/playwright.config.ts` for normal e2e job.
- Mail-delivery e2e job currently starts `wrangler dev` manually before running the single spec.

## Code conventions to follow
- For web server/edge error reporting, use `apps/web/src/lib/sentry.ts` helpers (`captureException`, `captureMessage`) instead of importing Sentry SDKs directly at call sites.
- Keep changes scoped to the touched workspace/package and run its local validation commands before broader runs.

## Errors encountered and workarounds
- Encountered while running `pnpm --filter web run build:cf`:
  - Error: `/bin/sh: 1: pnpm: not found` (triggered inside `opennextjs-cloudflare build` subprocess).
  - Workaround: run `corepack enable` once in the environment, then re-run the build command.
- Observed warnings during worker tests about compatibility date fallback in local runtime; tests still pass.
