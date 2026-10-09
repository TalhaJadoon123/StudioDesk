import { config } from '@studiodesk/shared';
import { createStudioDesk, seedDemoStudio } from '@studiodesk/core';
import { buildServer } from './server.js';

/**
 * API entrypoint: `npm run dev:api` / `npm start:api`.
 *
 * On boot, if the demo studio flag is set the database is seeded so a fresh
 * clone has something to look at immediately.
 */
/**
 * Hard ceiling on how long a graceful shutdown may take. An orchestrator sends
 * SIGTERM and then SIGKILLs; we must exit first so in-flight requests finish.
 */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);

async function main(): Promise<void> {
  const desk = await createStudioDesk();

  if (process.env.SEED_ON_BOOT === 'true' || process.argv.includes('--seed')) {
    const seeded = await desk.ctx.repo.table('members').count();
    if (seeded === 0) {
      console.log('[api] empty database - seeding the demo studio');
      await seedDemoStudio(desk.ctx);
    }
  }

  const app = await buildServer({
    desk,
    // Rate limiting is on by default outside tests; `npm run dev:api` gets it
    // too, which is what you want even locally.
    rateLimit: process.env.RATE_LIMIT_DISABLED === 'true' ? { max: 0, windowMs: 0 } : undefined,
  });

  const port = config.port();
  const host = process.env.HOST ?? '0.0.0.0';

  try {
    await app.listen({ port, host });
    app.log.info(`StudioDesk API on http://localhost:${port} (driver: ${desk.ctx.repo.kind})`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, draining connections`);

    // Never hang past the orchestrator's kill window.
    const timer = setTimeout(() => {
      app.log.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref?.();

    try {
      // Stops accepting new connections, lets in-flight requests finish.
      await app.close();
      clearTimeout(timer);
      app.log.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    app.log.error({ err: error }, 'uncaught exception, exiting');
    process.exit(1);
  });
}

main().catch((error) => {
  console.error('[api] failed to start:', error);
  process.exit(1);
});