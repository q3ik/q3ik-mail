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
 *   - Client: via `sentry.client.config.ts` → `@sentry/nextjs` init
 */

const SERVER_SDK = '@sentry/cloudflare';
const CLIENT_SDK = '@sentry/nextjs';

function isServer(): boolean {
  return (
    process.env.NEXT_RUNTIME === 'edge' ||
    process.env.NEXT_RUNTIME === 'nodejs' ||
    typeof window === 'undefined'
  );
}

export async function captureException(err: unknown): Promise<void> {
  try {
    const sdk = await import(isServer() ? SERVER_SDK : CLIENT_SDK);
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
    const sdk = await import(isServer() ? SERVER_SDK : CLIENT_SDK);

    if (context) {
      sdk.withScope((scope: { setLevel: (l: string) => void; setTags: (t: Record<string, string>) => void; setExtras: (e: Record<string, unknown>) => void }) => {
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
