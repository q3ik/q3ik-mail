// Sentry edge config — intentionally minimal.
// The full @sentry/nextjs Node SDK must NOT initialise in the Cloudflare
// Workers runtime: it pulls in async_hooks / AsyncLocalStorage internals
// that cause a hard crash (TypeError: Cannot read properties of undefined
// (reading 'bind')) even with the nodejs_compat compatibility flag set.
//
// We skip init entirely in the Workers runtime and rely on the client-side
// SDK (sentry.client.config.ts) for error reporting.
import * as Sentry from '@sentry/nextjs';

const edgeRuntimeName = (globalThis as typeof globalThis & {
  EdgeRuntime?: string;
}).EdgeRuntime;

// EdgeRuntime is defined in Vercel Edge Functions but absent in
// Cloudflare Workers — use that to gate the init.
if (typeof edgeRuntimeName === 'undefined') {
  // Running inside Cloudflare Workers — skip Sentry Node init.
} else {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.2,
    environment: process.env.NODE_ENV,
  });
}
