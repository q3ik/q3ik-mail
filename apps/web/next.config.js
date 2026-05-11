// @ts-check

/** @type {import('next').NextConfig} */
const nextConfig = {};

if (process.env.NODE_ENV === 'development') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { setupDevPlatform } = require('@cloudflare/next-on-pages/next-dev');
  (async () => {
    await setupDevPlatform();
  })();
}

module.exports = nextConfig;
