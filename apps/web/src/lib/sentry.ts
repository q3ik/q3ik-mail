export async function captureException(err: unknown): Promise<void> {
  const serverSdk = '@sentry/cloudflare';
  const clientSdk = '@sentry/nextjs';

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
