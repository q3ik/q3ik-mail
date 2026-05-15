/**
 * Next.js instrumentation hook.
 *
 * `@sentry/nextjs` handles both Node.js and edge (workerd) runtimes,
 * so we use it directly here instead of `@sentry/cloudflare` (which
 * is designed for raw Cloudflare Workers/Pages and does not export an
 * `init()` function compatible with Next.js instrumentation hooks).
 *
 * Client-side Sentry is initialised separately via `instrumentation-client.ts`
 * (the Next.js 15+ convention for client-side instrumentation).
 */
import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (
    process.env.NEXT_RUNTIME === 'edge' ||
    process.env.NEXT_RUNTIME === 'nodejs'
  ) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
        ? (Number.parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0)
        : 0.2,
      environment: process.env.NODE_ENV ?? 'production',
    });
  }
}

/**
 * Captures errors from nested React Server Components and other server-side
 * request-level errors.  Required by `@sentry/nextjs` — see:
 * https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/#errors-from-nested-react-server-components
 */
export const onRequestError = Sentry.captureRequestError;
