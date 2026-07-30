# Copilot Cloud Agent Instructions for q3ik-mail

> **CRITICAL:** Prefer these documented steps over exploratory `grep`/`find`/text searches. Only search if a referenced file path is missing or a command fails.

## Quick repo map
- Monorepo: `pnpm` workspaces + Turborepo.
- Apps:
  - `apps/web`: Next.js App Router UI + API routes (Cloudflare/OpenNext target).
  - `apps/worker`: Cloudflare Worker for inbound webhook ingestion + scheduled rethreading.
- Packages:
  - `packages/database`: D1 schema, migrations, typed query helpers.
  - `packages/emails`: React email templates.
  - `packages/ts-config`: Shared TS configs.

## First-time setup
- Node.js **v22** (enforced).
- From repo root:
  ```bash
  corepack enable
  corepack pnpm install --frozen-lockfile
  ```

## Fast validation commands (per workspace)

| Workspace | Commands |
|-----------|----------|
| Worker | `pnpm --filter @q3ik-mail/worker typecheck && pnpm --filter @q3ik-mail/worker lint && pnpm --filter @q3ik-mail/worker test` |
| Database | `pnpm --filter @q3ik-mail/database typecheck && pnpm --filter @q3ik-mail/database test` |
| Web | `pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web test` |
| Web (Cloudflare build) | `pnpm --filter web run build:cf` |

## D1 + migrations rules
- Migrations live in `packages/database/migrations`.
- Run migrations from `apps/worker`:
  ```bash
  pnpm --filter @q3ik-mail/worker wrangler d1 migrations apply q3ik-mail-db --local
  ```
- `wrangler.toml` files contain `database_id = "REPLACE_WITH_YOUR_DATABASE_ID"` – **never commit a real ID**.
- `000_init.sql` is the squashed early history.

## Critical architectural invariants (MUST follow)

### 1. Next.js edge runtime
Every route/page in `apps/web` must include:
```typescript
export const runtime = 'edge';
```

### 2. Cloudflare runtime context – NO `process.env`
Always use the request‑scoped bindings:
```typescript
const { env } = getRequestContext();
const db = env.DB;
```

### 3. Inbound webhook signature verification (worker)
Consume the raw body **before** parsing JSON:
```typescript
const rawBody = await request.text();  // required for crypto check
// then JSON.parse(rawBody) if needed
```

### 4. Threading isolation
The inbound ingester uses `In-Reply-To` headers to trace `thread_id`. Never assume a direct relationship between `resend_id` fields.

## Test/CI behavior to align with
- CI order: config guard → typecheck → lint → migration validation → unit tests → e2e.
- E2E: Playwright `webServer` in `apps/web/playwright.config.ts` for normal runs.
- Mail‑delivery e2e starts `wrangler dev` manually before the single spec.

## Code conventions
- For web error reporting, use `apps/web/src/lib/sentry.ts` helpers (`captureException`, `captureMessage`) – do not import Sentry SDK directly.
- Keep changes scoped to the touched workspace; run its local validation before broader runs.

## Known errors & workarounds
- **`/bin/sh: 1: pnpm: not found`** during `build:cf`  
  → Run `corepack enable` once in the environment, then retry.
- **Worker test warnings about compatibility date fallback**  
  → Safe to ignore; tests still pass.
- **Local D1 state dirty or missing**  
  → Re‑run the migration command above; it regenerates `.wrangler/state`.

## Security & secrets
- Production uses Cloudflare Access (Zero Trust) – JWT validation at edge.
- No production secrets or database IDs committed. CI injects placeholders.
