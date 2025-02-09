# Oryn — Backend Engineering Instructions

Oryn is an intelligent email automation platform backend: unified inboxes across
Gmail and Outlook, AI classification/summaries/auto-replies, a rules engine,
scheduled sending, semantic search, webhooks, background jobs, analytics,
multi-tenant RBAC, and audit logging.

**This repository is BACKEND ONLY. No frontend/UI work.**

## Hard requirements

- **Framework: NestJS with TypeScript.** HTTP layer = Nest controllers/providers
  (`@Controller`, `@Get`, ...) exposed under the global prefix `/api/v1`.
  Do NOT introduce Next.js or standalone Express/Fastify apps — the Nest
  platform adapter owns the HTTP server.
- PostgreSQL (Drizzle ORM), Redis + BullMQ queues, Zod validation, structured
  logging (pino), Vitest tests (unit + e2e via `@nestjs/testing`).
- Business logic lives in services/repositories under `src/modules/*` — never
  inside controllers. Providers stay behind Gmail/Outlook adapters.
- Every feature ships with unit/integration/e2e tests. Mock external providers
  in tests only.
- Environment variables only for secrets (see `.env.example`). Never hard-code.
- Conventional Commits. Commit after every completed task. **Never push.**

## Security baseline

Treat email data as sensitive: authn/authz on every protected resource, OAuth
state validation, AES-256-GCM encrypted provider tokens at rest, input
validation, rate limiting, CSRF protection, SSRF protection, safe attachment
handling (MIME sniffing, size limits), sanitization of email HTML and AI
prompts (prompt-injection defense), audit logging, tenant isolation, no
cross-user data access, safe error messages, no secrets in logs. Do not trust:
email HTML, attachment MIME types, user URLs, webhook payloads, AI output.

## Layout

```
src/main.ts               # NestFactory bootstrap, global prefix api/v1
src/app.module.ts         # root module
src/modules/<domain>      # module + controller + service (+ repository, schemas)
src/lib/*                 # db, queue, redis, crypto, logger, http kernel
src/providers/*           # Gmail / Outlook adapters (EmailProvider interface)
src/jobs/*                # BullMQ processors
tests/*                   # e2e tests + helpers/setup
```

## API contract

Base URL `/api/v1`. Full endpoint list lives in `docs/API.md` and is mirrored by
the generated OpenAPI document at `/api/v1/openapi.json` (@nestjs/swagger).
Response envelope:

```jsonc
// success (collection)
{ "data": [], "pagination": { "page": 1, "limit": 50, "total": 230, "hasNextPage": true, "hasPreviousPage": false } }
// error
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": null, "requestId": "req_123" } }
```

Stable machine-readable codes: UNAUTHORIZED, FORBIDDEN, VALIDATION_ERROR,
RESOURCE_NOT_FOUND, EMAIL_ACCOUNT_NOT_CONNECTED, OAUTH_TOKEN_EXPIRED,
PROVIDER_RATE_LIMITED, PROVIDER_UNAVAILABLE, SYNC_FAILED, ATTACHMENT_TOO_LARGE,
INVALID_ATTACHMENT, RULE_EXECUTION_FAILED, AI_SERVICE_UNAVAILABLE.

Async operations return job identifiers instead of holding requests open.
