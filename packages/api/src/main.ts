import { config } from '@studiodesk/shared';
import { createStudioDesk, seedDemoStudio } from '@studiodesk/core';
import { buildServer } from './server.js';

/**
 * API entrypoint: `npm run dev:api` / `npm start:api`.
 *
 * On boot, if the demo studio flag is set the database is seeded so a fresh
 * clone has something to look at immediately.
 */
async function main(): Promise<void> {
  const desk = await createStudioDesk();

  if (process.env.SEED_ON_BOOT === 'true' || process.argv.includes('--seed')) {
    const seeded = await desk.ctx.repo.table('members').count();
    if (seeded === 0) {
      console.log('[api] empty database - seeding the demo studio');
      await seedDemoStudio(desk.ctx);
    }
  }

  const app = await buildServer({ desk });

  const port = config.port();
  const host = process.env.HOST ?? '0.0.0.0';

  try {
    await app.listen({ port, host });
    app.log.info(`StudioDesk API on http://localhost:${port} (driver: ${desk.ctx.repo.kind})`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[api] failed to start:', error);
  process.exit(1);
});