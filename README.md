# QuoteIQ

A multi-tenant insurance **Leads and Quotation Intelligence** platform: a TypeScript/React
SaaS application backed by Supabase PostgreSQL and deployable to Vercel.

- **Backend** — TypeScript on Vercel-compatible serverless functions (`api/`, `src/server/`),
  built with Hono, Kysely/pg, and Zod. The `/api/v1` surface is the application API.
- **Frontend** — React + TypeScript + Redux Toolkit single-page app (`src/ui/`).
- **Database** — Supabase PostgreSQL. Schema lives in `supabase/migrations/` (plain SQL).
- **Auth** — Supabase Auth (asymmetric ES256 JWTs locally).
- **Background jobs** — Supabase-native: `pg_cron` schedules and `pgmq` queues, driven by the
  handlers under `src/server/jobs/` (see [`docs/background-jobs.md`](./docs/background-jobs.md)).
- **Local stack** — the Supabase CLI local development stack running on Docker. There is **no**
  .NET runtime, Keycloak, Vault, MinIO, Liquibase, or Hangfire dependency.

## Prerequisites

- **Node.js 22+** (npm 11+).
- **Docker Desktop / Engine**, running before any `supabase:*` script.
- The **Supabase CLI** is pinned as a devDependency and installed by `npm install` — no separate
  install is required.

## Quick start

```bash
npm install
npm run supabase:start   # boots the local Supabase stack (Postgres, Auth, Storage, Studio)
npm run supabase:reset   # replays all migrations from empty, then applies the baseline seed
npm run db:seed:demo     # layers on the full demo dataset (two tenants, personas, leads, quotes)
npm run dev              # API on http://127.0.0.1:3001 + SPA on http://localhost:5173
```

Open http://localhost:5173 and sign in with a seeded demo persona (password `test1234`).
Reprint the local stack URLs and keys at any time with `npx supabase status`.

The full clean-checkout runbook, including authentication details and troubleshooting, is
[`docs/local-development.md`](./docs/local-development.md).

## Local services

Once the stack is up (`run.ps1`, or `npm run supabase:start` + `npm run dev`), these run locally.
Every value here is a **local-development default**. Print the live keys and connection string at
any time with `npx supabase status`.

| Service | URL / address | Access |
|---|---|---|
| App — SPA (open this) | http://localhost:5173 | sign in as a seeded user below |
| App — API runner | http://127.0.0.1:3001/api/v1 | same browser session; proxied by the SPA |
| Supabase Studio (database GUI) | http://127.0.0.1:54323 | none required locally |
| Email inbox — Mailpit | http://127.0.0.1:54324 | none — catches all outbound local email (e.g. password-reset links) |
| Supabase API gateway | http://127.0.0.1:54321 | anon / service-role keys via `npx supabase status` |
| Postgres | host `127.0.0.1`, port `54322`, database `postgres`, user `postgres`, password `postgres` | local default |

> The Supabase **anon key**, **service-role key**, **JWT secret**, and the full credentialed
> connection string are printed by `npx supabase status` and stored in the git-ignored `.env.local`
> (the browser-safe `VITE_SUPABASE_*` values live there too). They are intentionally **not**
> committed in tracked files — the CI secret scan (`npm run ci:security`) fails the build if a key
> or credentialed URL appears in one.

## Seeded demo users

`npm run db:seed:demo` (or `run.ps1 -Reset -Demo`) loads two tenants — **Kalahari Insurance (Pilot)**
and **Okavango Risk Partners** — and sixteen users. **Every user's password is `test1234`**, and
every email ends in `@quoteiq.local` (sign in with the full address). A few to start with:

| Email (`…@quoteiq.local`) | Role | Tenant(s) |
|---|---|---|
| `internal.admin` | Internal Administrator (cross-tenant) | both + global |
| `pilot.admin` | Tenant Administrator | Kalahari (Pilot) |
| `sales.manager` | Sales Manager | both |
| `rm.tebogo` | Relationship Manager | Kalahari |
| `disabled.user` | deactivated (sign-in refused, by design) | Kalahari |

The **complete sixteen-persona list** (all roles across both tenants) is in
[`docs/local-development.md`](./docs/local-development.md#demo-seed).

## Testing

```bash
npm test                 # backend unit + integration (integration requires the local stack)
npm run typecheck        # strict backend TypeScript check
npm run lint             # ESLint over api/, src/server/, scripts/
npm run test -w src/ui   # SPA unit tests
npm run test:e2e         # Playwright e2e suite (needs the app running; see docs/local-development.md)
npm run db:validate      # replays every migration from empty and diffs against supabase/schema.expected.sql
npm run ci:test          # backend suite exactly as CI runs it (asserts test total, fails on any skip)
```

## Documentation

| Topic | Doc |
|---|---|
| Clean-checkout local development runbook | [`docs/local-development.md`](./docs/local-development.md) |
| Environment variables | [`docs/environment-variables.md`](./docs/environment-variables.md) |
| Deployment (Vercel + hosted Supabase) | [`docs/deployment.md`](./docs/deployment.md) |
| Background jobs (pg_cron / pgmq) | [`docs/background-jobs.md`](./docs/background-jobs.md) |

> All local credentials are **local-development defaults only** and must never be reused in any
> shared or production environment.
