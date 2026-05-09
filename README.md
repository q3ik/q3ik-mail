# q3ik-mail

**q3ik-mail** (pronounced *quick mail*) is a high-performance, single-user serverless email client built on the Cloudflare ecosystem and Resend. It provides a modern, fast, and secure way to manage emails on your custom domain with zero infrastructure costs for a single user.

## 🚀 Architecture

- **Frontend:** Next.js (App Router) deployed on Cloudflare Pages.
- **Worker:** Cloudflare Worker acting as a high-speed ingestion engine for Resend Inbound webhooks.
- **Database:** Cloudflare D1 (SQLite) for relational storage and conversation threading.
- **Email Engine:** Resend for both Inbound (receiving) and Outbound (sending).
- **Security:** Cloudflare Access (Zero Trust) for identity-based authentication.

## 📁 Project Structure

```text
├── apps/
│   ├── web/           # Next.js Dashboard (shadcn/ui Mail)
│   └── worker/        # Inbound Webhook Handler & Threading Logic
├── packages/
│   ├── database/      # D1 Schema, Migrations, and Typed Queries
│   ├── emails/        # React Email templates for outbound mail
│   └── ts-config/     # Shared TypeScript configurations
...
```

<TODO: Complete>
