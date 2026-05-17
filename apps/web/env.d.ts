/// <reference types="@cloudflare/workers-types" />

interface CloudflareEnv {
  DB: D1Database;
  EMAIL_BODIES?: R2Bucket;
  RESEND_API_KEY: string;
  THREAD_LIST_CURSOR_SECRET: string;
  AUTH_SECRET: string;
  SENTRY_DSN: string;
  NEXT_PUBLIC_SENTRY_DSN: string;
}
