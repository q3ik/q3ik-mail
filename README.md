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

Create your D1 database and apply all migrations from `packages/database/migrations/`:

```bash
# Create the database (one-time setup — copy the returned database_id into apps/worker/wrangler.toml)
npx wrangler d1 create q3ik-mail-db

# Apply migrations to the local development database
cd apps/worker
npx wrangler d1 migrations apply q3ik-mail-db --local

# Apply migrations to the remote (production) database
npx wrangler d1 migrations apply q3ik-mail-db --remote

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

### 5. Cloudflare Access Hardening

After deploying the Pages app, configure the Access Application in the [Zero Trust dashboard](https://one.dash.cloudflare.com/) under **Access → Applications → q3ik-mail → Additional Settings → Cookie settings**:

| Setting | Required value | Why |
|---|---|---|
| **HTTP Only** | **ON** | Prevents client-side JavaScript from reading the Access JWT cookie, mitigating XSS-based token theft. |
| **Binding Cookie** | **ON** | Binds the JWT session to the user's TLS connection, protecting against cookie replay attacks. Safe for all web app clients (do not enable for SSH/RDP applications). |
| **Same Site Attribute** | `Strict` (recommended) | Prevents the session cookie from being sent in cross-site requests. Set to `Lax` only if you need OAuth redirects from third-party IdPs to carry the session. |

**Copy the AUD tag:**
1. In **Access → Applications**, open the q3ik-mail app and go to **Additional Settings → AUD tag**.
2. Copy the token value.
3. Set it as `CLOUDFLARE_ACCESS_AUD` in your Pages deployment environment variables (`wrangler secret put CLOUDFLARE_ACCESS_AUD` or via the Cloudflare dashboard).
4. Set `CLOUDFLARE_TEAM_DOMAIN` to your Zero Trust team domain (e.g. `your-team.cloudflareaccess.com`).

The middleware in `apps/web/src/middleware.ts` verifies the Access JWT on every non-public request. With HTTP Only and Binding Cookie enabled, Cloudflare delivers the JWT as a `CF_Authorization` cookie for browser sessions and as a `CF-Access-Jwt-Assertion` header for API/service token requests. The middleware handles both paths.

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
