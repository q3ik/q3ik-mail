/**
 * Sentry capture helpers for the Cloudflare Worker.
 *
 * Wraps @sentry/cloudflare calls in defensive try/catch so a Sentry
 * transport failure (network timeout, misconfigured DSN, etc.) never
 * causes a 500 response or crashes the worker.
 *
 * With `Sentry.withSentry()` wrapping the handler in index.ts, the
 * Sentry hub is active during request processing. These helpers import
 * the same `@sentry/cloudflare` module and capture through the active hub.
 */
import * as Sentry from '@sentry/cloudflare';

export function captureException(
  err: unknown,
  context?: Parameters<typeof Sentry.captureException>[1],
): void {
  try {
    Sentry.captureException(err, context);
  } catch (captureError) {
    console.error('[sentry] captureException failed:', captureError);
  }
}

export function captureMessage(
  message: string,
  context?: Parameters<typeof Sentry.captureMessage>[1],
): void {
  try {
    Sentry.captureMessage(message, context);
  } catch (captureError) {
    console.error('[sentry] captureMessage failed:', captureError);
  }
}

export function addBreadcrumb(breadcrumb: Sentry.Breadcrumb): void {
  try {
    Sentry.addBreadcrumb(breadcrumb);
  } catch (captureError) {
    console.error('[sentry] addBreadcrumb failed:', captureError);
  }
}
