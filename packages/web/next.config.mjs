/** @type {import('next').NextConfig} */
const nextConfig = {
  // Monorepo packages ship TypeScript source, so Next compiles them itself.
  // Keeping them outside `node_modules` also avoids symlink resolution issues.
  transpilePackages: ['@studiodesk/shared', '@studiodesk/core', '@studiodesk/booking', '@studiodesk/billing', '@studiodesk/checkin'],
  experimental: {
    externalDir: true,
  },
  // Cloudflare Pages serves the static export; no Node runtime required.
  output: 'standalone',
  eslint: { ignoreDuringBuilds: true },
  env: {
    NEXT_PUBLIC_API_URL: process.env.API_URL ?? 'http://localhost:4000',
  },
};

export default nextConfig;
