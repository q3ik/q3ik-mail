// @ts-check

const isDev = process.env.NODE_ENV === 'development';

/**
 * Sentry ingest domain for the CSP connect-src directive.
 */
const sentryIngestDomain = 'https://*.ingest.us.sentry.io';

/**
 * Content-Security-Policy for the q3ik-mail web app.
 *
 * Threat model:
 * - HTML email bodies are rendered inside <iframe sandbox=""> with srcDoc,
 *   which blocks script execution and same-origin access inside the frame.
 * - img-src restricts tracker pixels in the *parent* page context.
 * - frame-src 'none' is safe because email iframes use srcDoc (not src).
 * - unsafe-inline for style-src is required for Tailwind and email body CSS.
 */
const cspHeader = [
  "default-src 'self'",
  `script-src 'self'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: cid:",
  "font-src 'self'",
  `connect-src 'self' ${sentryIngestDomain}`,
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        // Apply security headers to all routes.
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: cspHeader },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

if (isDev) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { initOpenNextCloudflareForDev } = require('@opennextjs/cloudflare');
  initOpenNextCloudflareForDev();
}

/**
 * `withSentryConfig` is not used here.
 *
 * Sentry works without it via the instrumentation hooks:
 *   - Server-side: `src/instrumentation.ts` calls `Sentry.init()`
 *   - Client-side: `instrumentation-client.ts` calls `Sentry.init()`
 *   - Error helpers: `src/lib/sentry.ts` uses `@sentry/nextjs` directly
 *   - CSP above allows `connect-src` to Sentry's ingest domain
 *
 * Source-map uploads can be added later via `sentry-cli` in CI once
 * SENTRY_AUTH_TOKEN is configured, or by adding `withSentryConfig` here.
 */
module.exports = nextConfig;
