import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const p = (...s: string[]) => path.join(root, ...s);

/**
 * Packages ship TypeScript source directly (no build step) so that the whole
 * monorepo is runnable with `tsx` / Next.js transpilation / vitest aliases.
 * The aliases below are the single source of truth for module resolution in
 * tests and mirror the `paths` block in tsconfig.json.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@studiodesk/shared': p('packages/shared/src/index.ts'),
      // Deep imports resolve before the package alias, so test fixtures can be
      // shared across packages without being duplicated.
      '@studiodesk/core/test': p('packages/core/test'),
      '@studiodesk/core': p('packages/core/src/index.ts'),
      '@studiodesk/booking': p('packages/booking/src/index.ts'),
      '@studiodesk/billing': p('packages/billing/src/index.ts'),
      '@studiodesk/checkin': p('packages/checkin/src/index.ts'),
      '@studiodesk/api': p('packages/api/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    // Test files import shared fixtures from another package; keep them in the
    // typecheck (tsconfig.json) and out of the published build.
    reporters: ['default'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'packages/shared/src/**/*.ts',
        'packages/core/src/**/*.ts',
        'packages/booking/src/**/*.ts',
        'packages/billing/src/**/*.ts',
        'packages/checkin/src/**/*.ts',
      ],
      exclude: ['**/scripts/**', '**/*.d.ts'],
    },
  },
});
