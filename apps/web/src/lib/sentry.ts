/**
 * Runtime-adaptive Sentry helpers.
 *
 * On Cloudflare Pages the server runs in workerd (V8 isolate) so we must use
 * `@sentry/cloudflare` for server-side capture, while the browser bundle uses
 * `@sentry/nextjs`.  These thin wrappers dynamically import the correct SDK so
 * that callers (middleware, API routes, components) don't need to care.
 *
 * The SDK is already initialised by the time these helpers are called:
 *   - Server/edge: via `src/instrumentation.ts` → `@sentry/cloudflare` init
 *   - Client: via `instrumentation-client.ts` → `@sentry/nextjs` init
 *
 * NOTE: The `import()` calls use string literals (not variables) so that
 * Webpack can statically analyse and tree-shake the unused SDK from each
 * bundle (client vs server/edge).
 */

function isServer(): boolean {
  return (
    process.env.NEXT_RUNTIME === 'edge' ||
    process.env.NEXT_RUNTIME === 'nodejs' ||
    typeof window === 'undefined'
  );
}

export async function captureException(err: unknown): Promise<void> {
  try {
    const sdk = isServer()
      ? await import('@sentry/cloudflare')
      : await import('@sentry/nextjs');
    sdk.captureException(err);
  } catch (captureError) {
    // Absorb any SDK-level failures so callers are never interrupted by a
    // Sentry reporting failure.  Log to console as a last-resort signal.
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
    const sdk = isServer()
      ? await import('@sentry/cloudflare')
      : await import('@sentry/nextjs');

    if (context) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdk.withScope((scope: any) => {
        if (context.level) scope.setLevel(context.level);
        if (context.tags) scope.setTags(context.tags);
        if (context.extra) scope.setExtras(context.extra);
        sdk.captureMessage(message);
      });
    } else {
      sdk.captureMessage(message);
    }
  } catch (captureError) {
    console.error('[sentry] captureMessage failed:', captureError);
  }
}
