# q3ik-mail

**q3ik-mail** (pronounced *quick mail*) is a high-performance, single-user serverless email client built on the Cloudflare ecosystem and Resend. It provides a modern, fast, and secure way to manage emails on a custom domain with zero infrastructure costs.

## Architecture

- **apps/web** — Next.js 15 inbox UI deployed to Cloudflare Pages
- **apps/worker** — Cloudflare Worker handling inbound email webhooks from Resend
- **packages/database** — Shared TypeScript types and D1 query helpers
- **packages/emails** — React Email templates for outbound mail
- **packages/ts-config** — Shared TypeScript configurations

```text
├── apps/
│   ├── web/           # Next.js Dashboard (shadcn/ui Mail)
│   └── worker/        # Inbound Webhook Handler & Threading Logic
├── packages/
│   ├── database/      # D1 Schema, Migrations, and Typed Queries
│   ├── emails/        # React Email templates for outbound mail
│   └── ts-config/     # Shared TypeScript configurations
```

## Prerequisites

- [Node.js](https://nodejs.org) 22+
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

For remote (production):

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
npx wrangler secret put SENTRY_DSN   # optional — worker runs without it
```

For the Web app:

```bash
cd apps/web
npx wrangler secret put RESEND_API_KEY
```

### 5. Configure Resend inbound webhook

In the [Resend dashboard](https://resend.com/inbound), create an inbound route pointing to your deployed worker URL (e.g. `https://q3ik-mail-worker.<your-subdomain>.workers.dev`) and copy the webhook signing secret into `RESEND_WEBHOOK_SECRET`.

## Development

```bash
# Run all apps in parallel (separate terminals)
pnpm --filter @q3ik-mail/web dev
pnpm --filter @q3ik-mail/worker dev
```

## Deployment

```bash
# Deploy the Worker
pnpm --filter @q3ik-mail/worker deploy

# Build and deploy the web app via Cloudflare Pages CI
pnpm --filter @q3ik-mail/web build:cf
# Or manually:
npx wrangler pages deploy .vercel/output/static
```

## Type checking

```bash
pnpm --filter @q3ik-mail/database typecheck
pnpm --filter @q3ik-mail/worker typecheck
pnpm --filter @q3ik-mail/web typecheck
```

## Security

- Authentication is handled by [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/) (Zero Trust). Add your Pages domain as a protected application in the Cloudflare Zero Trust dashboard.
- Inbound webhook signatures are verified using [svix](https://docs.svix.com/receiving/verifying-payloads/how) before any email data is processed.
- Sentry error monitoring is optional — omitting `SENTRY_DSN` does not affect worker functionality.
