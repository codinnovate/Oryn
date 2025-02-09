# Oryn

Intelligent email automation platform backend: unified inboxes across Gmail and
Outlook, AI classification/summaries/replies, a rules engine, scheduled sending,
semantic search, analytics, and multi-tenant RBAC.

**Backend only** — NestJS + TypeScript, exposed under `/api/v1`.

## Stack

- NestJS 11 (Express adapter), TypeScript strict
- PostgreSQL 17 + Drizzle ORM
- Redis + BullMQ for background jobs
- Zod validation, structured logging (pino), Vitest tests

## Local development

Requires Node >= 22, pnpm, PostgreSQL 17 and Redis.

```bash
pnpm install
cp .env.example .env   # fill in secrets
# Option A: docker compose up -d postgres redis
# Option B: use an existing Postgres; point DATABASE_URL at it
pnpm dev               # http://localhost:3000/api/v1/health
```

## Testing

```bash
pnpm test              # unit + e2e (uses DATABASE_URL / REDIS_URL from tests/setup.ts)
pnpm typecheck && pnpm lint && pnpm build
```

## Layout

See `AGENTS.md` for architecture rules and the API contract.
