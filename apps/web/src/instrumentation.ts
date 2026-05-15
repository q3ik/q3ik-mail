/**
 * Next.js instrumentation hook — server-side Sentry initialisation.
 *
 * Uses a dynamic import of `@sentry/nextjs` to avoid a static module
 * reference that would be duplicated across every edge function when
 * @cloudflare/next-on-pages bundles the Vercel output.
 *
 * Client-side Sentry is initialised separately via `instrumentation-client.ts`
 * (the Next.js 15+ convention for client-side instrumentation).
 */

export async function register() {
  if (
    process.env.NEXT_RUNTIME === 'edge' ||
    process.env.NEXT_RUNTIME === 'nodejs'
  ) {
    const Sentry = await import('@sentry/nextjs');
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
export async function onRequestError(
  ...args: Parameters<typeof import('@sentry/nextjs').captureRequestError>
) {
  const Sentry = await import('@sentry/nextjs');
  return Sentry.captureRequestError(...args);
}
