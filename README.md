# q3ik-mail

**q3ik-mail** (pronounced *quick mail*) is a high-performance, single-user serverless email client built on the Cloudflare ecosystem and Resend. It provides a modern, fast, and secure way to manage emails on your custom domain with zero infrastructure costs for a single user.

## 🚀 Architecture

* **Frontend:** Next.js (App Router) deployed on **Cloudflare Pages**.
* **Worker:** **Cloudflare Worker** acting as a high-speed ingestion engine for Resend Inbound webhooks.
* **Database:** **Cloudflare D1** (SQLite) for relational storage and conversation threading.
* **Email Engine:** **Resend** for both Inbound (receiving) and Outbound (sending).
* **Security:** **Cloudflare Access** (Zero Trust) for identity-based authentication.

## 📁 Project Structure

```text
├── apps/
│   ├── web/           # Next.js Dashboard (shadcn/ui Mail)
│   └── worker/        # Inbound Webhook Handler & Threading Logic
├── packages/
│   ├── database/      # D1 Schema, Migrations, and Typed Queries
│   ├── emails/        # React Email templates for outbound mail
│   └── ts-config/     # Shared TypeScript configurations

```

## 🛠️ Setup & Deployment

### 1. Database Initialization

Create your D1 database and apply the schema found in `packages/database/schema.sql`:

```bash
# Create the database
npx wrangler d1 create q3ik-mail-db

# Run migrations (Remote)
npx wrangler d1 execute q3ik-mail-db --remote --file=packages/database/schema.sql

```

### 2. Environment Configuration

Set the following secrets in both `apps/web` and `apps/worker` using `wrangler secret put`:

* `RESEND_API_KEY`: Your API key from the Resend dashboard.
* `RESEND_WEBHOOK_SECRET`: The secret provided when you register your webhook URL.

### 3. Deploying the Ingestion Worker

```bash
cd apps/worker
pnpm run deploy

```

*Note: After deployment, register the Worker URL in the Resend Dashboard for the `email.received` event.*

### 4. Deploying the Web Dashboard

```bash
cd apps/web
pnpm run deploy

```

## 🧠 Technical Highlights

* **Advanced Threading:** The ingestion worker walks up `In-Reply-To` and `Message-ID` chains to group emails into threads.
* **Resilience:** Out-of-order emails are flagged with `needs_rethreading` and can be processed via the `/api/rethread` endpoint.
* **Edge Performance:** Utilizes the `@cloudflare/next-on-pages` runtime to ensure database queries happen at the edge with minimal latency.

## 🧪 Testing

The project uses **Vitest** for unit tests and **Playwright** for E2E testing.

```bash
pnpm run test

```

## 🛡️ License

MIT
