/**
 * Next.js instrumentation hook.
 *
 * On Cloudflare Pages the server-side runtime is workerd (V8 isolate), not
 * Node.js, so we initialise `@sentry/cloudflare` here instead of the default
 * `@sentry/nextjs` server SDK.
 *
 * Client-side Sentry is initialised separately via `sentry.client.config.ts`
 * (loaded automatically by the `withSentryConfig` webpack plugin).
 */
export async function register() {
  if (
    process.env.NEXT_RUNTIME === 'edge' ||
    process.env.NEXT_RUNTIME === 'nodejs'
  ) {
    const Sentry = await import('@sentry/cloudflare');

    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
        ? parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE)
        : 0.2,
      environment: process.env.NODE_ENV ?? 'production',
    });
  }
}
