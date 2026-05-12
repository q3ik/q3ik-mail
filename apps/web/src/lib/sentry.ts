export async function captureException(err: unknown): Promise<void> {
  const serverSdk = '@sentry/cloudflare';
  const clientSdk = '@sentry/nextjs';

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

  const { captureMessage: captureMessageImpl, withScope } = await import(sdkToImport);
  withScope((scope) => {
    if (context?.level) scope.setLevel(context.level);
    if (context?.tags) scope.setTags(context.tags);
    if (context?.extra) scope.setExtras(context.extra);
    captureMessageImpl(message);
  });
}
