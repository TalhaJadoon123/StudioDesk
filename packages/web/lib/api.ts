import 'server-only';
import { createStudioDesk, type StudioDesk } from '@studiodesk/core';

/**
 * Server-side data access for Next.js.
 *
 * Pages call the service functions directly rather than fetching over HTTP.
 * That removes a network hop, keeps types end to end, and means the web app and
 * the API cannot diverge. The Fastify server still exists for the mobile app
 * and any third-party integration.
 */

const GLOBAL_KEY = Symbol.for('studiodesk.web.desk');

type GlobalWithDesk = typeof globalThis & { [GLOBAL_KEY]?: StudioDesk };

export function desk(): StudioDesk {
  const globalRef = globalThis as GlobalWithDesk;
  if (!globalRef[GLOBAL_KEY]) {
    globalRef[GLOBAL_KEY] = createStudioDesk();
  }
  return globalRef[GLOBAL_KEY]!;
}

export function driverName(): string {
  return desk().ctx.repo.kind;
}
