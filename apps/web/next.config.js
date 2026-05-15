// @ts-check
const { withSentryConfig } = require('@sentry/nextjs');

const isDev = process.env.NODE_ENV === 'development';

/**
 * Sentry ingest domain for the CSP connect-src directive.
 *
 * Client-side events are sent directly to the ingest endpoint (no tunnel) to
 * stay compatible with @cloudflare/next-on-pages which does not support the
 * Sentry tunnel rewrite.
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
  const { setupDevPlatform } = require('@cloudflare/next-on-pages/next-dev');
  (async () => {
    await setupDevPlatform();
  })();
}

module.exports = withSentryConfig(nextConfig, {
  // Sentry org & project for source-map uploads.
  // Requires SENTRY_AUTH_TOKEN in the build environment.
  org: 'q3ik',
  project: 'q3ik-mail-web',

  // Only print upload logs in CI.
  silent: !process.env.CI,

  // Upload a wider set of source maps for better stack traces.
  widenClientFileUpload: true,

  // NOTE: tunnelRoute is intentionally omitted — @cloudflare/next-on-pages
  // does not support Sentry's rewrite-based tunnel and it causes a
  // "duplicated identifier" build error. Client-side events are sent
  // directly to Sentry's ingest endpoint (allowed by the CSP above).
});
