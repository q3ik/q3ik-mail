# q3ik-mail

A serverless email client built on Cloudflare Pages, Cloudflare Workers, and Cloudflare D1, powered by the [Resend](https://resend.com) email API.

## Architecture

- **apps/web** — Next.js 15 inbox UI deployed to Cloudflare Pages
- **apps/worker** — Cloudflare Worker handling inbound email webhooks from Resend
- **packages/database** — Shared TypeScript types and D1 query helpers

## Prerequisites

- [Node.js](https://nodejs.org) 20+
- [pnpm](https://pnpm.io) 10+
- A [Cloudflare](https://cloudflare.com) account
- A [Resend](https://resend.com) account with a verified domain

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Create the D1 database

```bash
npx wrangler d1 create q3ik-mail-db
```

Copy the `database_id` from the output and replace the `REPLACE_WITH_YOUR_DATABASE_ID` placeholder in **both** wrangler.toml files:

- `apps/worker/wrangler.toml`
- `apps/web/wrangler.toml`

### 3. Run the database migration

```bash
npx wrangler d1 execute q3ik-mail-db --file=packages/database/schema.sql
```

For local development:

```bash
npx wrangler d1 execute q3ik-mail-db --local --file=packages/database/schema.sql
```

### 4. Set secrets

For the Worker:

```bash
cd apps/worker
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_WEBHOOK_SECRET
npx wrangler secret put SENTRY_DSN
```

For the Web app:

```bash
cd apps/web
npx wrangler secret put RESEND_API_KEY
```

### 5. Configure Resend inbound webhook

In the Resend dashboard, create an inbound route pointing to your deployed worker URL and copy the webhook signing secret into `RESEND_WEBHOOK_SECRET`.

## Development

```bash
# Run all apps in parallel (requires separate terminals)
pnpm --filter @q3ik-mail/web dev
pnpm --filter @q3ik-mail/worker dev
```

## Deployment

```bash
# Deploy the Worker
pnpm --filter @q3ik-mail/worker deploy

# Build and deploy the web app
pnpm --filter @q3ik-mail/web build
# Then deploy with Cloudflare Pages CI or: npx wrangler pages deploy
```

## Type checking

```bash
pnpm --filter @q3ik-mail/database typecheck
pnpm --filter @q3ik-mail/worker typecheck
pnpm --filter @q3ik-mail/web typecheck
```
