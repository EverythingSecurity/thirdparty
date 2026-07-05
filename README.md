# VSA Platform

Vendor Security Assessment platform — monorepo scaffold (Sprint 1).

## Layout

```
apps/
  api/          Fastify REST API (staff JWT + vendor token auth, RBAC, scoring, AI orchestration)
  web/          React SPA (Vendor 1a, Reviewer 1d, Risk Manager 1g/1h, Admin 1j)
db/             @vsa/db — Prisma schema, migrations, seed
packages/
  shared/       @vsa/shared — RBAC types, roles, error envelope
```

Sprint 6 will add `apps/worker` for async AI generation via Azure Service Bus.

## Prerequisites
- Node.js ≥ 20, npm ≥ 10
- Docker (for local Postgres + Redis)

## Local dev

```bash
cp .env.example .env
npm install
npm run docker:up            # Postgres + Redis
npm run db:generate          # Prisma client
npm run db:migrate           # apply migrations
npm run db:seed              # SCF TPM controls + demo org/vendor
npm run dev                  # start API on :4000
npm run dev:web              # start web SPA on :5173 (in a second terminal)
# or: npm run dev:all        # both in parallel
```

Smoke test:
```bash
curl http://localhost:4000/health
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start API in watch mode |
| `npm run build` | Build all workspaces |
| `npm run typecheck` | tsc --noEmit across all workspaces |
| `npm run lint` | ESLint across all workspaces |
| `npm run test` | Vitest across all workspaces |
| `npm run db:migrate` | Apply Prisma migrations (dev) |
| `npm run db:seed` | Seed reference data |
| `npm run db:reset` | Drop DB, re-migrate, re-seed |

## Azure deployment

See [`infra/README.md`](./infra/README.md) for the Bicep + GitHub Actions deploy flow.

Quick tour of what runs where:
- **API** (`vsa-api`) — Azure Container Apps, Node 20 alpine image, ingress on 4000
- **Web** (`vsa-web`) — Azure Container Apps, nginx serving Vite build, ingress on 8080
- **Postgres** — Azure Database for PostgreSQL Flexible Server v16
- **Secrets** — Azure Key Vault, injected into Container Apps via Managed Identity
- **Telemetry** — Application Insights (workspace-based) + Log Analytics

## Auth (Sprint 1)

- **Staff**: JWT (HS256 in dev via `JWT_DEV_SECRET`; swap to Entra ID JWKS in prod). Contains `sub`, `org_id`, `role`.
- **Vendor**: opaque bearer token. Stored as HMAC-SHA256 (server pepper) in `vendor_invites.token_hash`. Raw token returned to admin once at issue time.

## RBAC (Sprint 1)

Server-enforced in the query/service layer per blueprint §5.2. Guards live in `@vsa/shared` and `apps/api/src/plugins/rbac.ts`. Reviewer scoping is data-driven via `routing_rules`.
