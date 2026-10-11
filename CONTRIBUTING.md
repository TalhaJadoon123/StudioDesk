# Contributing to StudioDesk

Thank you for your interest in contributing! This document outlines the process and standards for contributing to StudioDesk.

---

## Code of Conduct

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md) (adapted from Contributor Covenant).

---

## Getting Started

### Prerequisites

- Node.js >= 20.11
- npm >= 10.x
- Git

### Setup

```bash
# Clone the repository
git clone https://github.com/TalhaJadoon123/StudioDesk.git
cd StudioDesk

# Install root dependencies (API + core packages)
npm ci

# Install web dependencies (Next.js)
npm run setup:web

# Install mobile dependencies (Expo)
npm run setup:mobile

# Run tests to verify setup
npm test
```

### Development Workflow

```bash
# Start API server (with hot reload)
npm run dev:api
# → http://localhost:4000

# Start web app (in separate terminal)
npm run dev:web
# → http://localhost:3000

# Start mobile app (in separate terminal)
npm run dev:mobile
# → Expo dev tools
```

---

## Project Structure

```
packages/
├── api/           # Fastify HTTP API + Cloudflare Workers entrypoint
├── billing/       # Gateways, invoices, packs, fees, dunning, PDF
├── booking/       # Calendar, RRULE, waitlist, instructors
├── checkin/       # QR, geofence, kiosk, mobile, manual
├── core/          # Repository, members, classes, bookings, churn, reports
├── docs/          # Documentation (Architecture, Deploy, Operations)
├── mobile/        # Expo app (schedule, bookings, check-in, wallet)
├── shared/        # Types, money, dates, config, errors, events
└── web/           # Next.js dashboard + marketing site
```

### Key Architectural Principles

1. **No build step** — TypeScript source runs directly via `tsx` / Next.js / Wrangler
2. **Single source of truth** — Domain logic in `packages/core`, consumed by API, web, mobile, tests
3. **Dependency direction** — `shared → core → (booking, billing, checkin) → api → (web, mobile)`
3. **Offline-first** — In-memory repo by default, all integrations optional
4. **Deterministic tests** — Pinned clock, in-memory repo, mock gateway

---

## Development Standards

### TypeScript

- **Strict mode** — `tsconfig.json` enforces strict checks
- **No `any`** — Use `unknown` and type narrowing
- **Explicit returns** — All exported functions must have explicit return types
- **Branded types** — Use `MemberId`, `ClassId`, etc. for IDs
- **Discriminated unions** — For state machines (e.g., `BookingStatus`)

### Code Style (Enforced by CI)

- **ESLint** — `@typescript-eslint` with strict rules
- **Prettier** — Single quotes, 2 spaces, trailing commas, 100 char line width
- **Run locally**: `npm run lint` (after adding ESLint config)

### Testing

- **Framework**: Vitest
- **Environment**: Node (tests use in-memory repo)
- **Deterministic**: Pinned clock (`harness(T0)`), no `Date.now()` in domain logic
- **Mock gateway**: `createMockGateway()` for payment tests
- **Coverage target**: > 80% (currently ~69%)

```bash
# Run all tests
npm test

# Run specific package tests
npm test -- packages/core/test/members.test.ts

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

### Commits

- **Conventional Commits** — `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `security:`
- **Scope** — Include package name: `feat(core): add member pause`
- **Atomic** — One logical change per commit

### Pull Requests

1. **Branch from `main`** — `feat/description` or `fix/description`
2. **Run gates locally** — `npm run release:gate` must pass
3. **Fill PR template** — Link issues, describe changes, note breaking changes
4. **CI must pass** — All GitHub Actions checks green
5. **Review required** — 1 approval minimum
6. **Squash merge** — Keep history clean

---

## Adding Features

### 1. Domain Logic (packages/core, booking, billing, checkin)

```typescript
// 1. Add Zod schema in validation.ts (if new input)
// 2. Add types in types.ts (if new entity)
// 3. Implement in domain file (members.ts, bookings.ts, etc.)
// 4. Export from package index.ts
// 5. Add tests in package test/ directory
// 6. Wire into API routes (packages/api/src/server.ts)
```

### 2. API Routes (packages/api/src/server.ts)

```typescript
// 1. Add Zod schema for request body/query
// 2. Add route handler using `route()` wrapper
// 3. Use `desk.<domain>.<function>(desk.ctx, input)`
// 4. Return typed response
// 5. Add test in packages/api/test/
```

### 3. Web UI (packages/web)

```bash
# 1. Add page/component in app/(app)/
# 2. Use lib/desk.ts for API calls
# 3. Run typecheck: npm --prefix packages/web run typecheck
# 4. Build: npm --prefix packages/web run build
```

### 4. Mobile (packages/mobile)

```bash
# 1. Add screen in app/(tabs)/
# 2. Use lib/api.ts for API calls
# 3. Run typecheck: npm --prefix packages/mobile run typecheck
```

---

## Release Process

### Versioning

- **Semantic Versioning** — MAJOR.MINOR.PATCH
- **Release tags** — `v1.0.0`, `v1.1.0`, etc.

### Release Gates (All Must Pass)

```bash
npm run release:gate
```

This runs:
1. `verify` — All package entry points resolve
2. `scan:secrets:selftest` — Secret scanner self-test
3. `scan:secrets` — No secrets in tracked files
4. `check:deploy` — Dockerfile/compose hardening
5. `check:env` — All env vars documented
6. `audit:errors` — No plain `Error` throws in prod paths
7. `typecheck:all` — Source + tests compile
8. `test` — All 294 tests pass

### Release Steps

```bash
# 1. Ensure main is up to date
git checkout main && git pull

# 2. Run full gate locally
npm run release:gate

# 3. Tag release
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0

# 4. GitHub Actions deploys from tag
#    - Workers (production env)
#    - Pages (production env)
```

---

## Reporting Issues

### Bug Reports

Use the bug report template — include:
- Steps to reproduce
- Expected vs actual behavior
- Environment (Node version, OS, package versions)
- Relevant logs/error messages

### Security Issues

**Do not open public issues** for security vulnerabilities.
Email: security@studiodesk.example.com (or use GitHub Security Advisories)

### Feature Requests

Use the feature request template — include:
- User story format: "As a [role], I want [goal] so that [benefit]"
- Acceptance criteria
- Priority justification

---

## Code Review Checklist

When reviewing PRs, verify:

- [ ] TypeScript compiles (`npm run typecheck:all`)
- [ ] Tests pass (`npm test`)
- [ ] New code has tests
- [ ] No `any` types introduced
- [ ] Zod schemas for new inputs
- [ ] Error handling uses `AppError`
- [ ] Money in integer cents
- [ ] Dates in UTC ISO strings
- [ ] No hardcoded secrets
- [ ] Documentation updated (README, spec.md if behavior changes)
- [ ] Conventional commit messages

---

## Questions?

- Open a Discussion on GitHub
- Check existing issues/PRs
- Review `packages/docs/ARCHITECTURE.md` for context

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License (see [LICENSE](LICENSE)).