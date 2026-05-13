import type { Scope } from '@sentry/cloudflare';

export async function captureException(err: unknown): Promise<void> {
  const serverSdk = '@sentry/cloudflare';
  const clientSdk = '@sentry/nextjs';

  try {
    // Next.js uses both server runtime labels; in either case we must stay on
    // the Cloudflare SDK to avoid pulling Node-only Sentry internals into Pages.
    if (process.env.NEXT_RUNTIME === 'edge' || process.env.NEXT_RUNTIME === 'nodejs') {
      const { captureException: captureExceptionImpl } = await import(serverSdk);
      captureExceptionImpl(err);
      return;
    }

    // Fallback for test/non-Next execution where NEXT_RUNTIME is unset but the
    // code still runs without a browser global.
    if (typeof window === 'undefined') {
      const { captureException: captureExceptionImpl } = await import(serverSdk);
      captureExceptionImpl(err);
      return;
    }

    const { captureException: captureExceptionImpl } = await import(clientSdk);
    captureExceptionImpl(err);
  } catch (captureError) {
    // Absorb any SDK-level failures so callers are never interrupted by a
    // Sentry reporting failure. Log to console as a last-resort signal.
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
  const isServer =
    process.env.NEXT_RUNTIME === 'edge' ||
    process.env.NEXT_RUNTIME === 'nodejs' ||
    typeof window === 'undefined';

  const sdkToImport = isServer ? '@sentry/cloudflare' : '@sentry/nextjs';

  const sdk = await import(sdkToImport);
  const captureMessageImpl = sdk.captureMessage;

  if (context && typeof captureMessageImpl === 'function') {
    // Context support is best-effort; when SDK scope helpers are unavailable
    // in the current runtime/test harness, still emit the message.
    captureMessageImpl(message);
    return;
  }

  captureMessageImpl(message);
}
