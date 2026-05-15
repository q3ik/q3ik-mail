/**
 * Next.js instrumentation hook — server-side Sentry initialisation.
 *
 * With @opennextjs/cloudflare the app runs on the Node.js runtime,
 * so @sentry/nextjs can be imported statically and initialised via
 * the standard register() hook.
 *
 * Client-side Sentry is initialised separately via `instrumentation-client.ts`
 * (the Next.js 15+ convention for client-side instrumentation).
 */
import * as Sentry from '@sentry/nextjs';

export function register() {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
      ? (Number.parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0)
      : 0.2,
    environment: process.env.NODE_ENV ?? 'production',
  });
}

/**
 * Captures errors from nested React Server Components and other server-side
 * request-level errors.  Required by `@sentry/nextjs` — see:
 * https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/#errors-from-nested-react-server-components
 */
export const onRequestError = Sentry.captureRequestError;
