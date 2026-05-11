// @ts-check

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack(config, { isServer }) {
    if (isServer) {
      // Stub out Sentry's Node/OTEL internals that pull in async_hooks and
      // call .bind() on AsyncLocalStorage — both of which fail inside the
      // Cloudflare Workers runtime even with nodejs_compat enabled.
      config.resolve.alias = {
        ...config.resolve.alias,
        '@sentry/node': false,
        '@opentelemetry/context-async-hooks': false,
        '@opentelemetry/instrumentation': false,
      };
    }
    return config;
  },
};

if (process.env.NODE_ENV === 'development') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { setupDevPlatform } = require('@cloudflare/next-on-pages/next-dev');
  (async () => {
    await setupDevPlatform();
  })();
}

module.exports = nextConfig;
