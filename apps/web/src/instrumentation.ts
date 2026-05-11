export async function register() {
  if (process.env.NEXT_RUNTIME === 'edge' || process.env.NEXT_RUNTIME === 'nodejs') {
    // Prevent Next.js from trying to initialize the default server/edge Sentry
    // SDKs here; Cloudflare-compatible error capture is loaded via src/lib/sentry.ts.
    return;
  }
}
