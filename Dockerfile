# StudioDesk - API + web image
#
# Two stages: the web app is built with Next.js (needs dev deps), the API runs
# from TypeScript source via tsx (no build step needed at runtime).

FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache libc6-compat

# ---------------------------------------------------------------- deps ----
FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/booking/package.json packages/booking/
COPY packages/billing/package.json packages/billing/
COPY packages/checkin/package.json packages/checkin/
COPY packages/api/package.json packages/api/
COPY packages/docs/package.json packages/docs/
RUN npm install --omit=dev --ignore-scripts || npm install --ignore-scripts

# ----------------------------------------------------------------- api ----
FROM deps AS api
COPY tsconfig.json tsconfig.test.json ./
COPY packages ./packages
COPY scripts ./scripts
EXPOSE 4000
# tsx is a dev dependency, so install it explicitly for the runtime.
RUN npm install tsx --no-save || true
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "packages/api/src/main.ts"]

# ----------------------------------------------------------------- web ----
FROM base AS web
# The web app needs its own dependency tree (Next.js is not a root workspace).
COPY packages/web/package.json packages/web/
RUN npm --prefix packages/web install --ignore-scripts
COPY packages/web ./packages/web
COPY packages ./packages
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm --prefix packages/web run build
EXPOSE 3000
CMD ["npm", "--prefix", "packages/web", "run", "start"]

# ------------------------------------------------------------- default ----
FROM api AS default
