# Deployment

This document is the operator's runbook for taking QuoteIQ from a green build to running
deployed environments. Actual hosted provisioning is **human-owned and deferred to cutover**
(A-18): nobody can create the Vercel projects or hosted Supabase projects from this repository,
so every "run this in the dashboard" step below is a checklist item, not an automated one.

## Environment model (M-23, Q-11, Q-12)

Four environments, mapped to two persistent Supabase projects plus ephemeral previews:

| Environment | `APP_ENV` | Supabase project | Vercel | Data |
| --- | --- | --- | --- | --- |
| **Local** | `local` | Local stack (Docker, Supabase CLI) | `npm run dev` / `vercel dev` | Throwaway, on your machine |
| **Preview** | `preview` | **Shared non-production** project | Vercel Preview deployments (per PR/branch) | Non-production; **never Production data** |
| **Staging** | `staging` | Staging project (may be the shared non-prod project or its own) | Vercel (staging branch/alias) | Non-production; **never Production data** |
| **Production** | `production` | Dedicated Production project | Vercel Production (main branch) | Production |

Rules that follow from M-23:

- **One Supabase project per persistent environment.** Production has its own project. Preview
  and Staging share the non-production project (Q-11); Vercel Preview deployments all point at
  that same non-production Supabase project.
- **Preview and Staging never touch Production data or the Production Supabase project.** A
  Preview build that could reach Production is a release-blocking misconfiguration.
- Supabase database branching (Q-12) may be used to give a branch its own ephemeral database off
  the non-production project; if adopted, the branch's connection string is what that Preview
  deployment's `SUPABASE_DATABASE_URL` points at.

## Vercel project shape (M-22)

A single `vercel.json` at the repository root configures one Vercel project that builds the SPA
and the serverless functions together:

- `framework: vite`, output directory `src/ui/dist`.
- `buildCommand` runs the backend typecheck (`npm run typecheck`) before the SPA build
  (`npm run build:ui`), so a type error fails the deploy.
- `functions` declares the Node.js runtime and `maxDuration` for each function group:
  - `api/v1/[...segments].ts` — the single catch-all API function (`maxDuration` 30s).
  - `api/cron/*.ts` — the three cron endpoints (`maxDuration` 60s).
  - `api/queue/*.ts` — the queue-drain endpoint (`maxDuration` 60s).
- **No `crons` key — ever.** Schedules live in `supabase/migrations/` as `pg_cron` entries that
  invoke the cron/queue endpoints through `pg_net`. The regression test
  `src/server/tests/integration/vercel-config.test.ts` fails the build if a `crons` key is added.
  See [`background-jobs.md`](./background-jobs.md).
- **Security response headers are set by the Hono app, not `vercel.json`.** They must cover
  401/403/404/500 responses and must suppress HSTS outside deployed environments — behaviour the
  typed config module knows and static JSON does not. Do not move them into `vercel.json`.

## Per-environment setup checklist

Repeat for each persistent environment (Preview/Staging share the non-production Supabase project).

### 1. Supabase project

1. Create the Supabase project (Production gets its own; Preview/Staging share the non-prod one).
2. Enable the extensions the job platform needs — `pg_cron`, `pgmq`, `pg_net` — via the migrations
   (they are installed by `supabase/migrations/20260718000000_extensions.sql`, so applying
   migrations is enough; no manual dashboard toggle).
3. **Enable asymmetric JWT signing keys (A-10).** Token verification uses `auth.getClaims()`
   against the project's JWKS, not a shared HS256 secret. Confirm the project is issuing ES256 (or
   another asymmetric) access tokens; do **not** configure `SUPABASE_JWT_SECRET` (it has no
   consumer and is intentionally absent from the catalog).
4. **Auth site URL / redirect URLs.** Set the Auth "Site URL" and allowed redirect URLs to the
   environment's deployed origin (and any preview alias domains). Self-service signup stays
   **disabled** — users are provisioned through the Auth Admin API by User Manager.

### 2. Apply migrations

Migrations are plain SQL in `supabase/migrations/`, applied in timestamp order. Apply them to the
target project through `SUPABASE_DIRECT_DATABASE_URL` (never the pooler). Validate locally first with
`npm run db:validate` (migration-from-clean). The schema must build from empty; CI proves this on
every push.

### 3. Configure environment variables

Set every variable from [`environment-variables.md`](./environment-variables.md) in the Vercel
project, scoped to the matching environment. The variables marked **Vercel Sensitive** must be
created as *Sensitive Environment Variables* (write-only after save). Placeholders and the full
list are in `.env.example`.

Point the database URLs at the right connection:

- `SUPABASE_DATABASE_URL` → the Supavisor **transaction pooler** (port 6543) — serverless runtime traffic.
- `SUPABASE_DIRECT_DATABASE_URL` → the **direct** Postgres connection — migrations and admin tooling.

### 4. Seed the database

Run the baseline seed against the target through `SUPABASE_DIRECT_DATABASE_URL`:

```bash
npm run db:seed -- --env=<environment>
```

A non-local target **refuses to run** unless you name it explicitly, and refuses if the flag names
a different environment than the loaded configuration resolves to (so a stale `--env=local` cannot
seed Production). The demo seed (`npm run db:seed:demo`) is **local/e2e only** and must never be
run against a deployed database.

### 5. Configure the job schedules (pg_cron → pg_net)

The `pg_cron` schedules are already created by migration, but they are **no-ops until you populate
the single-row `public.job_cron_config` table out of band** — no URL and no secret is ever
committed. Run once per environment, as the service role, in the Supabase SQL editor:

```sql
insert into public.job_cron_config (base_url, cron_secret, internal_job_secret)
values (
  'https://<this-environment-deployment-origin>',  -- no trailing slash
  '<this environment''s CRON_SECRET value>',
  '<this environment''s INTERNAL_JOB_SECRET value>'
)
on conflict (id) do update
   set base_url = excluded.base_url,
       cron_secret = excluded.cron_secret,
       internal_job_secret = excluded.internal_job_secret,
       updated_at = now();
```

`base_url` must be the **same origin** whose `CRON_SECRET` / `INTERNAL_JOB_SECRET` you set in step
3 — the database presents those secrets and the endpoints validate them. Details, and why this
table was chosen over `ALTER DATABASE ... SET` and over Supabase Vault, are in
[`background-jobs.md`](./background-jobs.md).

**On Preview, jobs are validated by manual invocation only (spec 9.5).** The deployed
`pg_cron → pg_net → endpoint` hop cannot be exercised until an origin is configured, and Preview
origins are ephemeral; invoke the endpoints directly with the secret to smoke-test them.

## SECURITY DEFINER standing rule (adopted from the T-032/T-034 pg_net defect)

`invoke_cron_endpoint` originally called `extensions.http_get(...)`. That function **does not
exist** — pg_net registers as an extension in the `extensions` schema but installs its functions
in the `net` schema (`net.http_get` / `net.http_post`). Every deployed cron would have failed
silently at its scheduled minute, and it passed **three** review layers (implementation,
evaluation, orchestrator snapshot) because every assertion inspected the function's **source
text** (`prosrc`) or the `cron.job` rows — neither of which requires the function to resolve, let
alone run.

**Standing rule:** any `SECURITY DEFINER` function that invokes an **extension** function must
have an integration test that **EXECUTES** it (against a rolled-back fixture row if it has side
effects), not one that merely inspects `prosrc`/`pg_proc` source text or catalog rows. Source
inspection cannot tell a resolvable call from an unresolvable one.

**Fix-forward history (so a future reader is not misled).** This repo does not edit applied
migrations. The original T-032 migration
`supabase/migrations/20260720000000_pg_cron_expiry_schedules.sql` **still literally contains**
`perform extensions.http_get(...)`. It is corrected forward by
`20260720010000_pg_cron_alert_and_drain_schedules.sql`, which `CREATE OR REPLACE`s the helper with
the `net.http_*` calls before `job_cron_config` is ever populated. On a clean apply the broken
function is created and then replaced within the same migration run, so the transient broken state
is unreachable; `npm run db:validate` confirms convergence. Reading only the T-032 migration would
mislead you — read the T-034 migration's header for the fix.

## Smoke tests after a deploy

1. `GET /api/v1/health` returns `200 {"status":"ok","version":"v1"}`.
2. Sign in with a provisioned user; the SPA loads the leads list and a dashboard with data.
3. Every response carries `x-correlation-id`, and the same id appears in the Vercel function logs.
4. Invoke each cron endpoint manually with the environment's `CRON_SECRET`
   (`Authorization: Bearer <secret>`) and confirm a `job_run` row is written; invoke
   `POST /api/queue/drain` with `INTERNAL_JOB_SECRET`.
5. Confirm the `pg_cron` schedules are firing (Supabase `cron.job_run_details`) once
   `job_cron_config` is populated with this environment's origin.

## Pre-cutover checklist (PRD 10.8)

- [ ] Migrations apply cleanly from empty against the target project (`db:validate` green).
- [ ] Baseline seed applied through `SUPABASE_DIRECT_DATABASE_URL` with the correct `--env`.
- [ ] All variables from `environment-variables.md` set; Sensitive ones marked Sensitive.
- [ ] `SUPABASE_DATABASE_URL` → pooler (6543); `SUPABASE_DIRECT_DATABASE_URL` → direct.
- [ ] Asymmetric JWT signing keys enabled; no `SUPABASE_JWT_SECRET` set.
- [ ] Auth Site URL / redirect URLs set to the deployed origin(s); signup disabled.
- [ ] `job_cron_config` populated out of band with this environment's origin and both secrets.
- [ ] `vercel build` succeeds; SPA + catch-all + cron + queue functions all present in the output.
- [ ] No `crons` key in `vercel.json` (vercel-config test green).
- [ ] Security scans green (`npm run ci:security`): `scripts/ci/scan-secrets.ts` (V-114) finds no
      committed secret in any tracked file, and `scripts/ci/scan-bundle.ts` (V-003) builds the SPA
      and finds no server variable name, `service_role`/`sb_secret_` literal, or `src/server`
      fragment in `src/ui/dist`. Both are composed into `npm run ci:test` and run as a dedicated CI
      step; see [environment-variables.md](./environment-variables.md#client-bundle-and-secret-hygiene).
- [ ] Smoke tests above all pass.
- [ ] Preview/Staging confirmed pointing at the **non-production** Supabase project only.

## Rollback

- **Application:** Vercel keeps every deployment; roll back by promoting the previous deployment.
  Functions are stateless, so a rollback is immediate and carries no data migration.
- **Database:** migrations are forward-only in this repo (applied migrations are never edited). A
  schema rollback is a new corrective migration, not an in-place edit. Never hand-edit an applied
  migration to "undo" it.
- **Job schedules:** the schedules are idempotent and state-guarded; disabling them for a rollback
  is a matter of clearing `job_cron_config` (they no-op with a NOTICE when it is empty) rather than
  dropping the `pg_cron` rows.

## Deployment automation (not enabled)

Deployment stays human-driven. `.github/workflows/ci.yml` ends with a commented-out `deploy` job
and the secrets it would need — `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, and for
hosted migrations `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`. None are
required for CI to pass. Wiring the `deploy` job is a cutover decision (A-18), not a repository
default. These are the **placeholders** to fill when automation is approved.
