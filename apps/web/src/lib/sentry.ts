/**
 * Sentry capture helpers.
 *
 * This file is imported by both client components (e.g. `global-error.tsx`)
 * and server/edge code (middleware, API routes), so it must use **dynamic
 * imports** — never a top-level `import * as Sentry from '...'`.
 *
 * Why dynamic imports?
 *   @cloudflare/next-on-pages bundles every edge function into a single
 *   worker file.  A static `import * as Sentry` causes the full
 *   `@sentry/nextjs` module graph to be inlined into every function that
 *   touches this helper, producing duplicate identifiers that
 *   next-on-pages rejects at build time.
 *
 * We use `@sentry/nextjs` for both server and client — it handles
 * Node.js, edge, and browser runtimes transparently.
 */

export async function captureException(err: unknown): Promise<void> {
  try {
    const Sentry = await import('@sentry/nextjs');
    Sentry.captureException(err);
  } catch (captureError) {
    console.error('[sentry] captureException failed:', captureError);
  }
}

export async function captureMessage(
  message: string,
  context?: {
    level?: 'error' | 'warning' | 'info' | 'debug';
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const Sentry = await import('@sentry/nextjs');

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
