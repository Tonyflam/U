/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@whalepod/config',
    '@whalepod/miniapp',
    '@whalepod/schema',
    '@whalepod/sdk',
    '@whalepod/vault',
  ],
  experimental: {
    serverComponentsExternalPackages: ['@aws-sdk/client-kms'],
  },
};
export default nextConfig;
