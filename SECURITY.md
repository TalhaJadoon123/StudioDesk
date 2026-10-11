# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | ✅ Yes    |
| < 1.0   | ❌ No     |

Only the latest stable release receives security updates.

---

## Reporting a Vulnerability

**Do not open public GitHub issues for security vulnerabilities.**

### How to Report

Email: **security@studiodesk.example.com**

Or use [GitHub Security Advisories](https://github.com/TalhaJadoon123/StudioDesk/security/advisories/new).

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)
- Your contact information for follow-up

### Response Timeline

| Severity | Acknowledgment | Fix Target |
|----------|----------------|------------|
| Critical | 24 hours       | 7 days     |
| High     | 48 hours       | 14 days    |
| Medium   | 5 days         | 30 days    |
| Low      | 10 days        | Next release |

---

## Security Measures Implemented

### Authentication & Authorization

- **API_KEY required in production** — Server refuses to boot without it (`server.ts:134-138`)
- **Bearer token** (`Authorization: Bearer <key>`) or **header** (`X-Api-Key: <key>`)
- **Timing-safe comparison** — Prevents timing attacks on API keys
- **Health probes public** — `/health`, `/ready` always accessible for orchestrators

### CORS

- **Explicit allowlist required in production** — `CORS_ORIGIN` (comma-separated)
- **Wildcard (`*`) blocked in production** — Server refuses to boot
- **Credentials only with explicit origin** — Never with `*`

### Rate Limiting

- **Fixed-window** — 300 requests/minute/IP default
- **Standard headers** — `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`
- **Health probes exempt**

### Security Headers (All Responses)

| Header | Value |
|--------|-------|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.groq.com https://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-DNS-Prefetch-Control` | `off` |
| `X-Powered-By` | Removed |

### Error Handling

- **5xx responses never leak internals** — `GENERIC_500_MESSAGE: "Something went wrong on our side."`
- **4xx responses return full details** — Validation errors, conflicts, etc.
- **Typed error hierarchy** — `AppError` with `ErrorCode` enum

### Secrets Management

- **Never committed** — `.gitignore` covers `.env`, `.env.local`, `*.key`, `*.pem`, etc.
- **Scanned in CI** — `scan-secrets.cjs` with self-test
- **Injected at runtime** — Cloudflare Workers secrets, Docker compose env vars
- **Test fixtures use obvious placeholders** — `whsec_test_secret`, `test-api-key-0123456789abcdef`

### Payment Security

- **Idempotency keys required** on all payment operations
- **Mock gateway** for tests — records calls, fails on demand
- **No SDKs** — plain `fetch` + `AbortController` (works on Workers)
- **PCI SAQ-A** — No card data touches our servers (Stripe/Polar/LemonSqueezy handle it)

### Dependency Security

- **npm audit in CI** — `npm audit --omit=dev` must pass
- **No post-install scripts** in dependencies
- **Lockfile committed** — `package-lock.json` with integrity hashes
- **Trivy container scan** in CI for Docker images
- **CodeQL analysis** in CI for source code

---

## Secure Deployment Checklist

Before deploying to production:

- [ ] `API_KEY` set (32+ chars, `openssl rand -hex 32`)
- [ ] `CORS_ORIGIN` set to explicit HTTPS origins (no `*`)
- [ ] `NODE_ENV=production`
- [ ] Supabase credentials configured (if using persistence)
- [ ] Payment gateway secrets via Cloudflare Workers secrets
- [ ] `CHECKIN_SIGNING_SECRET` rotated from default
- [ ] `NEXTAUTH_SECRET` rotated from default
- [ ] Docker images scanned with Trivy
- [ ] CI pipeline green on `main` branch
- [ ] Branch protection enabled on `main`

---

## Known Security Considerations

### Accepted Risks

1. **In-memory repository** — Data lost on restart (by design for demo mode)
2. **Fixed-window rate limit** — Not distributed (single-instance assumption)
3. **No CSP `script-src 'unsafe-inline'`** — Required for Next.js inline scripts
4. **Three plain `Error` throws in billing** — Test-only guard, email gateway errors (documented)

### Future Hardening

- [ ] Distributed rate limiting (Redis/Workers KV)
- [ ] Circuit breaker for external HTTP calls
- [ ] Request signing for webhook verification
- [ ] Audit logging for sensitive operations
- [ ] Automated dependency updates (Dependabot)

---

## Contact

Security Team: security@studiodesk.example.com

For urgent issues, include "URGENT" in subject line.