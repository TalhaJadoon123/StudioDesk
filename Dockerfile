# StudioDesk - API + web image
#
# Three stages: deps, api, web. The API runs from TypeScript source via tsx
# (no build step at runtime); the web app is compiled by Next.js.
#
# Hardening: non-root user, pinned base image, no dev dependencies in the API
# runtime layer, read-only-friendly filesystem, explicit healthcheck.

# syntax=docker/dockerfile:1

# ------------------------------------------------------------------ base --
FROM node:22.14-alpine3.21 AS base
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
RUN apk add --no-cache libc6-compat tini

# ------------------------------------------------------------------ deps --
# Build-time only. Carries the compiler chain needed to typecheck and to run
# tsx; the runtime stage copies only what it needs.
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/booking/package.json packages/booking/
COPY packages/billing/package.json packages/billing/
COPY packages/checkin/package.json packages/checkin/
COPY packages/api/package.json packages/api/
COPY packages/docs/package.json packages/docs/
RUN npm ci --no-audit --no-fund

# ------------------------------------------------------------------- api --
FROM deps AS api-build
COPY tsconfig.json tsconfig.test.json vitest.config.ts ./
COPY packages ./packages
# Fail the build if the source does not typecheck.
RUN npx tsc -p tsconfig.json --noEmit

FROM base AS api
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0
# Production dependencies from the committed lockfile, plus tsx to run the
# TypeScript sources. `npm ci` fails loudly on a lockfile mismatch.
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm ci --include=dev --no-audit --no-fund \
 && npm prune --omit=dev --no-audit --no-fund \
 && npm install --no-save --no-audit --no-fund tsx@4.19.2
COPY --from=api-build /app/packages ./packages
COPY --from=api-build /app/tsconfig.json ./tsconfig.json
COPY --from=api-build /app/tsconfig.test.json ./tsconfig.test.json
COPY --from=api-build /app/vitest.config.ts ./vitest.config.ts
COPY package.json ./
COPY scripts ./scripts

# Drop privileges. The node image ships a `node` user (uid 1000).
RUN chown -R node:node /app
USER node

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini reaps zombies and forwards SIGTERM, so graceful shutdown actually runs.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npx", "tsx", "packages/api/src/main.ts"]

# ------------------------------------------------------------------- web --
FROM base AS web-deps
COPY packages/web/package.json packages/web/
RUN npm --prefix packages/web ci --no-audit --no-fund || npm --prefix packages/web install --no-audit --no-fund

FROM web-deps AS web-build
COPY packages/web ./packages/web
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY packages/booking ./packages/booking
COPY packages/billing ./packages/billing
COPY packages/checkin ./packages/checkin
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm --prefix packages/web run build

FROM base AS web
ENV NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000
COPY --from=web-build /app/packages/web ./packages/web
COPY --from=api-build /app/packages/shared ./packages/shared
COPY --from=api-build /app/packages/core ./packages/core
COPY --from=api-build /app/packages/booking ./packages/booking
COPY --from=api-build /app/packages/billing ./packages/billing
COPY --from=api-build /app/packages/checkin ./packages/checkin
RUN chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "--prefix", "packages/web", "run", "start"]

# ----------------------------------------------------------------- api ----
FROM api AS default
