/**
 * Sentry capture helpers.
 *
 * With @opennextjs/cloudflare the full Node.js runtime is available,
 * so standard static imports of @sentry/nextjs work without the
 * duplicate-identifier issues that plagued @cloudflare/next-on-pages.
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
      Sentry.withScope((scope) => {
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
