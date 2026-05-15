/**
 * Sentry capture helpers.
 *
 * This file is imported by both client components (e.g. `global-error.tsx`)
 * and server code, so it must only reference `@sentry/nextjs` — never
 * `@sentry/cloudflare`, which depends on `node:async_hooks` and would cause
 * a webpack error when bundled for the browser.
 *
 * Server-side SDK *initialisation* also uses `@sentry/nextjs` (in
 * `src/instrumentation.ts`), which handles both Node.js and edge runtimes.
 */
import * as Sentry from '@sentry/nextjs';

export function captureException(err: unknown): void {
  try {
    Sentry.captureException(err);
  } catch (captureError) {
    console.error('[sentry] captureException failed:', captureError);
  }
}

export function captureMessage(
  message: string,
  context?: {
    level?: 'error' | 'warning' | 'info' | 'debug';
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
  },
): void {
  try {
    if (context) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Sentry.withScope((scope: any) => {
        if (context.level) scope.setLevel(context.level);
        if (context.tags) scope.setTags(context.tags);
        if (context.extra) scope.setExtras(context.extra);
        Sentry.captureMessage(message);
      });
    } else {
      Sentry.captureMessage(message);
    }
  } catch (captureError) {
    console.error('[sentry] captureMessage failed:', captureError);
  }
}
