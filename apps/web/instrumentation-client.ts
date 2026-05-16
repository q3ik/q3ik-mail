/**
 * Client-side Sentry initialisation (Next.js 15+ convention).
 *
 * This file replaces the deprecated `sentry.client.config.ts` pattern
 * and is automatically loaded by Next.js on every client navigation.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client
 */
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.2,
  replaysSessionSampleRate: 0.05,
  replaysOnErrorSampleRate: 1.0,
  integrations: [Sentry.replayIntegration()],
  environment: process.env.NODE_ENV,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
