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

### Seeding a deployed environment

`test1234` is a **local-only** default. It is committed to this repository, and the seed re-asserts
every persona's password on each run — so on anything reachable it would undo a rotation and
re-publish a known password every time someone re-seeded. Away from local the seed therefore
requires `DEMO_SEED_PASSWORD` and refuses without it:

```bash
doppler run -p qiq -c dev -- npm run db:seed:demo -- --env=dev
```

Two rules follow from that:

- **Set `DEMO_SEED_PASSWORD` in the secret store** for any environment that hosts demo data. It is
  a secret: it grants sign-in to all sixteen personas, including `internal.admin`.
- **The demo seed will not run against `production`, ever.** It is refused outright, before the
  `--env` gate — the dataset is fabricated tenants, users, leads and quotes, and nothing removes
  them again. Production is bootstrapped with `db:admin:create` instead (below).

Anything hosting demo personas is reachable by whoever learns its URL. A non-public password makes
that survivable; it does not make it private. If an environment needs to be private, put Vercel
Deployment Protection back and give pg_cron a bypass — see
[`docs/background-jobs.md`](./docs/background-jobs.md).

## Bootstrapping the first account

A freshly migrated environment has **no way to sign in**: the baseline seed creates the permission
catalog and reference-data template and deliberately no users, while User Manager — the normal way
to create accounts — requires being signed in already. That circularity is broken once, out of
band, by an operator holding the service-role key:

```bash
doppler run -p qiq -c prd -- npm run db:admin:create -- --email you@example.com --env=production
```

It creates one Internal, zero-tenant user holding every permission in the global scope, prints a
generated password **once**, and creates no data. Sign in, change the password, then use Tenant
Manager and User Manager for everything after that. Re-running re-asserts a new password, so a
lost bootstrap credential is recoverable.

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

## Deploying

Schema reaches a hosted environment through CI, never by hand. Push to `dev` and, once `verify`
passes, the `migrate` job applies migrations to **qiq-dev**; merging to `main` does the same for
**qiq-PROD**. Each branch selects a GitHub Environment, whose secrets are synced from Doppler, so
no project ref, password or URL appears in this repository.

| Branch | GitHub Environment | Doppler config | Supabase project | `APP_ENV` |
|---|---|---|---|---|
| `dev` | `dev` | `dev` | qiq-dev | `dev` |
| `main` | `Production` | `prd` | qiq-PROD | `production` |

Each run links to the project, prints the pending migrations **before** applying anything, pushes
them, applies the baseline seed, and writes `public.job_cron_config` so the `pg_cron -> pg_net`
schedules can authenticate. All three write steps converge on a re-run.

Two environment values are needed per deployed environment beyond the application catalog:

- **`JOB_CRON_BASE_URL`** — the origin pg_cron calls back on. It must be **stable**: a Vercel
  preview URL changes per deployment, so use a branch alias or a custom domain. Unset, the step
  skips and the schedules stay no-ops.
- **`DEMO_SEED_PASSWORD`** — only where demo data is hosted (see above).

The application itself deploys through Vercel's own Git integration, in parallel with this
workflow. For additive migrations that ordering is safe; a breaking change wants a human
sequencing the two.

## Documentation

| Topic | Doc |
|---|---|
| Clean-checkout local development runbook | [`docs/local-development.md`](./docs/local-development.md) |
| Environment variables | [`docs/environment-variables.md`](./docs/environment-variables.md) |
| Deployment (Vercel + hosted Supabase) | [`docs/deployment.md`](./docs/deployment.md) |
| Background jobs (pg_cron / pgmq) | [`docs/background-jobs.md`](./docs/background-jobs.md) |

> All local credentials are **local-development defaults only** and must never be reused in any
> shared or production environment.
