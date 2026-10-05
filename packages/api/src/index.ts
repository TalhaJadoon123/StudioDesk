/**
 * @studiodesk/api - Fastify HTTP API.
 *
 * `buildServer()` is the Node/Fastify entrypoint; `worker.ts` exposes the same
 * routes on Cloudflare Workers. Both share every route definition below.
 */

export { buildServer, default } from './server.js';
export type { BuildServerOptions } from './server.js';
export { seedDemoStudio, createStudioDesk } from '@studiodesk/core';
export type { StudioDesk } from '@studiodesk/core';