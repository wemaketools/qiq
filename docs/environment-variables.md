# Environment Variables

This is the authoritative catalog: every variable the application reads, its scope, its
sensitivity, and where it is configured. It is kept one-to-one with three things and a test
fails the build when they drift (`src/server/tests/unit/env-catalog-sync.test.ts`):

- the typed config schema `src/server/lib/config/schema.ts` (the only server surface that reads
  the environment — see the note at the bottom),
- `.env.example` (the deployed-environment placeholder file),
- `.env.local.example` (the local-stack values).

A variable that appears in one of these and not the others — or a variable the config module
reads that is undocumented here, or one documented here that the code never reads — is a defect.

## Browser-safe variables (exposed to the SPA)

These are compiled into the SPA bundle through Vite's `import.meta.env` and are therefore
**public by construction**. They must only ever carry values that are safe in a hostile browser.
They are read by SPA code (`src/ui`), not by the server config module.

| Variable | Scope | Sensitivity | Where configured |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | Browser (SPA build) | Public | Vercel env (all envs) / `.env.local` locally |
| `VITE_SUPABASE_ANON_KEY` | Browser (SPA build) | Public | Vercel env (all envs) / `.env.local` locally |

Why the anon key is safe to ship to the browser is explained under
[Why `VITE_SUPABASE_ANON_KEY` is safe](#why-vite_supabase_anon_key-is-safe-to-ship-to-the-browser).

## Server-only variables (never in the client bundle)

Read exclusively through the typed config module `src/server/lib/config`. Startup fails fast,
naming the offending variable, if any required one is missing or malformed. None of these may
appear in `src/ui` code or in the built SPA bundle (guarded by V-003 — see the
[bundle-scan note](#client-bundle-and-secret-hygiene)).

The **Vercel Sensitive** column marks the variables that must be created as *Vercel Sensitive
Environment Variables* in each deployed environment (A-5, tier 1): once set they are
write-only in the dashboard and never echoed back. Set the non-sensitive ones as ordinary
environment variables.

### Required (no default — absence is a hard startup failure)

| Variable | Scope | Sensitivity | Vercel Sensitive | Where configured |
| --- | --- | --- | --- | --- |
| `SUPABASE_URL` | Server-only | Low (project URL) | No | Vercel env / `.env.local` |
| `SUPABASE_ANON_KEY` | Server-only | Public value | No | Vercel env / `.env.local` |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only | **Secret** — bypasses RLS, drives Auth Admin API | **Yes** | Vercel env / `.env.local` |
| `DATABASE_URL` | Server-only (Supavisor pooler, runtime) | **Secret** — contains DB password | **Yes** | Vercel env / `.env.local` |
| `DIRECT_DATABASE_URL` | Server-only (migrations / admin) | **Secret** — contains DB password | **Yes** | Vercel env / `.env.local` |
| `CRON_SECRET` | Server-only (guards `/api/cron/*`) | **Secret** | **Yes** | Vercel env / `.env.local` + `job_cron_config.cron_secret` |
| `INTERNAL_JOB_SECRET` | Server-only (guards `/api/queue/drain`) | **Secret** | **Yes** | Vercel env / `.env.local` + `job_cron_config.internal_job_secret` |
| `API_KEY_PEPPER` | Server-only (Q-19 intake API-key hashing, min 16 chars) | **Secret** | **Yes** | Vercel env / `.env.local` |

The server reads its **own** `SUPABASE_URL` / `SUPABASE_ANON_KEY` (used for Supabase Auth token
verification via the JWKS) rather than the `VITE_`-prefixed browser copies; the values are the
same but the config module never reads a `VITE_` variable.

`CRON_SECRET` and `INTERNAL_JOB_SECRET` are used in two places per environment: the Vercel
function reads them through the config module to authenticate incoming job requests, and the
database's `public.job_cron_config` row holds a copy so the `pg_cron -> pg_net` schedules can
present them. See [`background-jobs.md`](./background-jobs.md).

### Optional (defaulted — omit to accept the default)

| Variable | Default | Allowed values | Sensitivity |
| --- | --- | --- | --- |
| `APP_ENV` | `local` | `local` \| `preview` \| `staging` \| `production` | Non-sensitive |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` | Non-sensitive |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` | Non-sensitive |
| `STORAGE_ADAPTER` | `supabase` | `supabase` \| `fake` | Non-sensitive |
| `STORAGE_ATTACHMENTS_BUCKET` | `quote-attachments` | lower-case bucket name | Non-sensitive |

`STORAGE_ADAPTER=fake` is the in-memory test seam and is **refused outside a local environment**
by `createStorageAdapter()` — composition throws if it is set in preview/staging/production
(A-6/Q-6). `STORAGE_ATTACHMENTS_BUCKET` names the private bucket provisioned by
`supabase/migrations/*_storage_buckets.sql`; attachment bytes are reached only through
short-lived signed URLs issued server-side after authorization (A-7).

## Deliberately absent

| Variable | Why it is not in the catalog |
| --- | --- |
| `SUPABASE_JWT_SECRET` | Token verification uses asymmetric signing keys via `auth.getClaims()` / JWKS (A-10); the legacy shared HS256 secret has no consumer. |
| `ERROR_TRACKING_DSN` | Error tracking is disabled for MVP (Q-13); no consumer exists. |
| Any Supabase Vault secret | Tenant-scoped secrets are **database-resident** Supabase Vault rows, not environment variables. Vault is **deferred / pattern-only** for MVP (Q-23); adopting it is a future decision, so there is nothing to configure here today. |

## Client bundle and secret hygiene

- **No server-only variable may leak into the SPA bundle.** V-003 is the built-bundle scan
  `scripts/ci/scan-bundle.ts` (T-051): it runs `npm run build:ui` and then scans every emitted
  asset under `src/ui/dist` for the server variable names (`SUPABASE_SERVICE_ROLE_KEY`,
  `DATABASE_URL`, `DIRECT_DATABASE_URL`, `CRON_SECRET`, `INTERNAL_JOB_SECRET`, `API_KEY_PEPPER`),
  for the `service_role` / `sb_secret_` literals, for `src/server/` module path fragments, and —
  when the server secret values are present in the scan environment — for those concrete values.
  It scans the compiled ARTIFACT, not the source, so a secret pulled into the bundle by a
  transitive or accidental import is caught where a source scan cannot see it. The unit-level guard
  `src/ui/src/auth/browserClientBoundary.test.ts` already proves the SPA *source* never imports the
  server config module or the service-role key; the built-bundle scan is its deployment-time
  counterpart. **Status:** wired into CI — `npm run ci:security` (composed by `npm run ci:test`, and
  a dedicated fast-feedback step in `.github/workflows/ci.yml`).
- **The example files carry placeholders only.** `.env.example` and `.env.local.example` are
  guarded by `src/server/tests/integration/env-examples.test.ts`, which rejects any JWT-shaped
  string or any `postgres://user:pass@` connection string with an inline credential. In addition,
  V-114's repo-wide scan `scripts/ci/scan-secrets.ts` (T-051) walks every TRACKED file for
  real-looking credentials (three-segment JWTs, `sb_secret_` keys, PEM private-key blocks,
  inline-credential postgres URLs, and high-entropy values assigned to secret-named variables) and
  fails the build on any match. Its allowlist is a short list of EXACT paths — the two `*.example`
  placeholder files and the deliberate synthetic-secret test fixtures
  (`src/server/tests/fixtures/log-fixture-secrets.ts`,
  `src/server/tests/fixtures/ci-scan-probe-secrets.ts`, and the two CI scanner test files) — never
  a broad glob, so it cannot silently widen into a hole. Never commit a real key, token, or
  password.
- `.gitignore` excludes `.env`, `.env.*` (except the two `*.example` files), `.vercel/`, and
  `*.log` / `logs/` / transient artifacts.

## Why `VITE_SUPABASE_ANON_KEY` is safe to ship to the browser

The anon key is public by design, and it is safe here for one specific reason: the `anon` and
`authenticated` PostgREST roles hold **no SELECT/INSERT/UPDATE/DELETE privilege on any table in
`public`**, so a direct Data API call with that key is refused by Postgres itself
(`42501 permission denied for table ...`) before any row is touched. The SPA reaches data only
through the application's own API, which enforces auth and tenant scope server-side.

Two properties of that lockdown are easy to get wrong:

- **It is grant-based, not policy-based.** Row Level Security is NOT adopted (spec.md Q-10, human
  decision 2026-07-20); there are no policies and no `ENABLE ROW LEVEL SECURITY` on application
  tables. Adding RLS policies would not change the outcome today, and their *absence* is not a gap.
- **A single stray `GRANT` silently removes it.** Any future migration containing
  `GRANT SELECT ON <table> TO anon` (or to `authenticated`) reopens direct browser access to that
  table's rows for every tenant at once, with no error and no other failing test. Since RLS is not
  adopted, this grant boundary is the **only** database-level protection of tenant data; app-layer
  tenant predicates (N-01) protect the application's own path and are verified per endpoint.

`src/server/tests/integration/data-api-lockdown.test.ts` is the regression guard. It enumerates the
privileges held by both roles across every table discovered in the live catalog (so new tables are
covered automatically) and fails naming the offending table if any DML privilege appears. Do not add
grants to `anon`/`authenticated` to make it pass.

## The single sanctioned environment read

`src/server/lib/config/index.ts` is the **only** module permitted to read `process.env`. A lint
rule (`no-restricted-properties` in `eslint.config.js`) and a test
(`src/server/tests/integration/config-env-access.test.ts`) enforce it. Every other server module
takes its configuration from `getConfig()`. This is why this catalog can be complete: there is
exactly one place variables enter the system.
