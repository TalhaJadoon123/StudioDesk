import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Monorepo packages ship TypeScript source, so Next compiles them itself.
  // Keeping them outside `node_modules` also avoids symlink resolution issues.
  transpilePackages: ['@studiodesk/shared', '@studiodesk/core', '@studiodesk/booking', '@studiodesk/billing', '@studiodesk/checkin'],
  // Cloudflare Pages serves the static export; no Node runtime required.
  output: 'standalone',
  eslint: { ignoreDuringBuilds: true },
  env: {
    NEXT_PUBLIC_API_URL: process.env.API_URL ?? 'http://localhost:4000',
  },
  webpack: (config, { isServer }) => {
    // Resolve .js imports to .ts files for monorepo packages
    config.resolve.extensions = ['.ts', '.tsx', '.js', '.jsx', ...config.resolve.extensions];
    config.resolve.alias = {
      ...config.resolve.alias,
      // Ensure .js imports resolve to .ts files in monorepo packages
      '@studiodesk/billing': path.resolve(__dirname, '../billing/src/index.ts'),
      '@studiodesk/shared': path.resolve(__dirname, '../shared/src/index.ts'),
      '@studiodesk/core': path.resolve(__dirname, '../core/src/index.ts'),
      '@studiodesk/booking': path.resolve(__dirname, '../booking/src/index.ts'),
      '@studiodesk/checkin': path.resolve(__dirname, '../checkin/src/index.ts'),
      // Web app internal aliases
      '@/lib': path.resolve(__dirname, './lib'),
      '@/app': path.resolve(__dirname, './app'),
      '@/components': path.resolve(__dirname, './components'),
      // Optional dependencies that are installed in web app
      '@pdfme/generator': path.resolve(__dirname, './node_modules/@pdfme/generator'),
      '@pdfme/schemas': path.resolve(__dirname, './node_modules/@pdfme/schemas'),
    };
    // Resolve .js to .ts for relative imports within monorepo packages
    config.resolve.fallback = {
      ...config.resolve.fallback,
    };
    // Add a custom resolver to handle .js -> .ts for billing package internal imports
    config.resolve.plugins = [
      ...(config.resolve.plugins || []),
      {
        apply: (resolver) => {
          const target = resolver.ensureHook('resolve');
          resolver
            .getHook('described-resolve')
            .tapAsync('MonorepoJsToTsResolver', (request, resolveContext, callback) => {
              if (!request.path.includes('packages')) return callback();
              if (request.request.endsWith('.js')) {
                const tsRequest = {
                  ...request,
                  request: request.request.replace(/\.js$/, '.ts'),
                };
                resolver.doResolve(target, tsRequest, 'Resolved .js to .ts for monorepo', resolveContext, callback);
              } else {
                callback();
              }
            });
        },
      },
    ];
    return config;
  },
};

export default nextConfig;
