# Local Development

> **Status: complete.** This document is the clean-checkout runbook: install → `supabase start`
> → reset/migrate/seed → run backend + SPA → sign in with a seeded user → run the unit,
> integration, and e2e suites, fully offline of any hosted service. Acceptance criterion AC-089 /
> verification V-115 is judged against it: a human must be able to follow it literally, top to
> bottom, with no undocumented step. The [clean-checkout walkthrough](#clean-checkout-walkthrough-v-115)
> at the end lists those steps in order. V-115 itself is a **manual** run performed at cutover.

The daily workflow runs entirely on your machine. No hosted Supabase project, no Vercel
account, and no network access to `supabase.com` is required (G-3, A-4).

## Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js 22 LTS or newer | The repository declares `engines.node: ">=22"`. Verified on Node 24.16.0. |
| Docker | Docker Desktop on Windows/macOS, Docker Engine on Linux. Must be **running** before any `supabase:*` script. Verified against Docker 29.1.3. |
| Supabase CLI | **Not a separate install.** The CLI is pinned as a devDependency (`supabase@2.109.1`) and comes with `npm install`. A globally installed CLI is fine but the pinned one is what the scripts use. |

Disk: the local stack pulls roughly 3–4 GB of Docker images on first `supabase start`.

## First-time setup

```bash
npm install
cp .env.local.example .env.local
npm run supabase:start
```

`npm run supabase:start` prints a JSON block containing `API_URL`, `DB_URL`, `ANON_KEY`, and
`SERVICE_ROLE_KEY`. Fill in `.env.local` from it:

- `VITE_SUPABASE_ANON_KEY` ← `ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` ← `SERVICE_ROLE_KEY`
- in `SUPABASE_DATABASE_URL` and `SUPABASE_DIRECT_DATABASE_URL`, replace `<local-db-password>` with `postgres`
  (the local database password; `DB_URL` shows the complete string)

Reprint all of these at any time with `npx supabase status`.

Those keys are the fixed, well-known keys the Supabase CLI issues to every local project.
They are **local-development-only**: they are not secrets, they grant nothing beyond your own
machine, and they must never be copied into a deployed environment's configuration.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run supabase:start` | Starts the local stack (Postgres, Auth, Storage, Studio, REST). Generates the local JWT signing key on first run. |
| `npm run supabase:stop` | Stops the containers. Data survives in a Docker volume. |
| `npm run supabase:reset` | Drops and recreates the local database, replays **all** migrations from empty, then runs `supabase/seed.sql`. This is the "give me a clean database" button. |
| `npm run db:migrate` | Applies any not-yet-applied migrations to the running local database, without dropping data. |
| `npm run db:seed` | Applies the **baseline seed** (permission catalog + global default reference template) to the configured database without dropping anything. Idempotent — safe to run any number of times. See [Seeding](#seeding). |
| `npm run typecheck` | Strict TypeScript check of the backend tree. |
| `npm run lint` | ESLint over `api/`, `src/server/`, `scripts/`. |
| `npm test` | Vitest unit + integration projects. |
| `npm run test:integration` | Integration project only. **Requires the local stack to be running.** |
| `npm run build:ui` | Production SPA build. |
| `npm run ci:test` | Backend suite exactly as CI runs it: asserts the expected test total and **fails on any skipped test**. Requires the local stack. |
| `npm run ci:test:ui` | SPA suite exactly as CI runs it (same count/skip assertions). |
| `npm run dev:api` | Serves the `/api/v1` function locally on http://127.0.0.1:3001 (see below). |
| `npm run dev:vercel` | `vercel dev` — the reference runner. Requires a globally installed Vercel CLI. |

Job and dev scripts (`dev`, `cron:list`, `cron:run`, `cron:run:all`, `queue:worker`,
`queue:enqueue:test`, `jobs:status`, `db:types`) are all implemented and run the same handler
code as the deployed endpoints. See [`background-jobs.md`](./background-jobs.md) for the job
commands and [Running the app locally](#running-the-app-locally) for `npm run dev`.

### Running the app locally

`/api/v1` is served by exactly one Vercel function, `api/v1/index.ts`, which hands every
request to the Hono app in `src/server/lib/router/app.ts`. There are no per-route functions.
Deployed, the whole surface reaches that function through the `/api/v1/:path*` rewrite in
`vercel.json` — see [`deployment.md`](./deployment.md). Neither `npm run dev` nor the test suites
go through Vercel's routing layer, so a routing change is only verifiable with `vercel build`
(inspect `.vercel/output/config.json`) or a real deployment.

**Everyday full-app command — `npm run dev`.** This starts both processes the app needs together:
the API function runner (`dev:api`, http://127.0.0.1:3001) and the SPA dev server
(`dev -w src/ui`, http://localhost:5173). Vite proxies `/api/v1` and `/api/cron` to the runner, so
the browser talks to a single origin. The Supabase Docker stack is **not** started here — start it
once with `npm run supabase:start`. Open http://localhost:5173 and sign in with a seeded user.

Two lower-level ways to run just the API:

- `npm run dev:vercel` runs `vercel dev`, the closest thing to the deployed runtime. It needs the
  Vercel CLI installed globally (`npm i -g vercel`) and a linked project; the CLI is deliberately
  **not** a repository dependency.
- `npm run dev:api` needs neither. It hosts the same app object over `node:http` via
  `scripts/dev/serve-api.ts`, using only Node built-ins and `tsx`. Same middleware, same error
  mapping, same log lines. Environment comes from `.env.local` through Node's own
  `--env-file-if-exists`.

```bash
npm run dev:api
curl -i http://127.0.0.1:3001/api/v1/health          # 200 {"status":"ok","version":"v1"}
curl -i http://127.0.0.1:3001/api/v1/nope            # 404 application/problem+json
curl -i -H 'x-correlation-id: abc-123' http://127.0.0.1:3001/api/v1/health
```

Every response carries `x-correlation-id` (echoed from the request when safe, otherwise generated)
and the same id appears in the request's JSON log line. T-018 points the SPA's Vite dev server at
this port with a `/api/v1` proxy.

### Security response headers

The baseline security headers from spec §16 are set by the Hono app itself, not by `vercel.json`.
Reasons: the .NET reference applied them in middleware so that 401/403/404/500 responses carry them
too, and matching that needs the same placement; HSTS must be suppressed outside deployed
environments, which the typed config module knows and static JSON does not; and in-app headers are
directly testable with `app.request(...)` instead of only after a deploy. `vercel.json` therefore
stays minimal — and, per M-22, must never gain a `crons` key, because schedules are `pg_cron`
entries in `supabase/migrations`.

## Local service endpoints

| Service | URL |
| --- | --- |
| API gateway (REST, Auth, Storage) | http://127.0.0.1:54321 |
| Postgres | `postgresql://postgres:<local-db-password>@127.0.0.1:54322/postgres` — the password is `postgres` (`npx supabase status` prints the full string) |
| Studio (database GUI) | http://127.0.0.1:54323 |
| Mail inbox (captures every outbound email, e.g. password resets) | http://127.0.0.1:54324 |

Realtime, Analytics/Logflare, and the Deno Edge Runtime are **disabled** in
`supabase/config.toml`: nothing in the architecture uses them, and leaving them off makes the
stack noticeably lighter and more reliable to start. See the comments in that file.

## Authentication in local development

Authentication runs against the local Supabase Auth (GoTrue) service inside the same Docker
stack — fully offline, with no external identity provider (A-4).

**Asymmetric JWT signing keys are enabled locally (A-10).** `supabase/config.toml` sets
`[auth].signing_keys_path`, and `npm run supabase:start` generates an ES256 key at
`supabase/signing_keys.json` on first run. Consequences worth knowing:

- Access tokens are signed **ES256**, not HS256. The backend verifies them offline through
  `auth.getClaims()` against the JWKS at
  `http://127.0.0.1:54321/auth/v1/.well-known/jwks.json` — the same code path used against a
  hosted project. Nothing shares an HS256 secret.
- `supabase/signing_keys.json` is **git-ignored and must never be committed** — it contains a
  private key. It is generated per machine. To rotate it, delete the file and restart the
  stack; regenerating invalidates any tokens you were holding.

**Self-service signup is disabled** (`[auth].enable_signup = false`). Users are provisioned
exclusively through the Auth Admin API by User Manager (T-017), matching the product's
intended behavior. Note the adjacent `[auth.email].enable_signup` flag must stay `true`: it
enables the email/password provider as a whole, and setting it false also rejects **sign-in**
with "Email logins are disabled".

Seeded sign-in credentials for local use come from the [demo seed](#demo-seed): run
`npm run db:seed:demo` and sign in as any persona with the password `test1234`.

## Database migrations

Migrations are plain SQL files in `supabase/migrations/`, applied in filename (timestamp)
order. The lowest-numbered file, `20260718000000_extensions.sql`, installs the extensions the
background-job platform depends on — `pg_cron`, `pgmq`, and `pg_net` (Q-7, G-4). They are
installed via migration rather than local config so hosted environments receive them through
the same path.

`supabase/seed.sql` runs automatically after migrations on every `supabase:reset`.

To validate that the schema builds from nothing — which CI also does (T-010) — run
`npm run supabase:reset` and confirm every migration applies without error.

## Seeding

Seed data comes in two layers:

| Layer | Contents | Applied by |
| --- | --- | --- |
| **Baseline** | The fixed permission catalog (81 codes) and the Internal-managed global default reference-data template (93 rows across ten lists). | `supabase db reset` automatically, and `npm run db:seed` on demand. |
| **Demo** | The full demo dataset — two tenants, 16 personas with local Auth identities, 18 brokers, 200 parties, 318 leads, 559 quotes, 400 follow-ups, 42 pricing approvals, alert-triggering fixtures, plausible history and sample job runs. | `npm run db:seed:demo` (layers on top of the baseline). See [Demo seed](#demo-seed). |

Both layers live in `supabase/seed.sql`. The baseline layer is delimited by
`-- >>> QUOTEIQ BASELINE SEED BEGIN` / `-- <<< QUOTEIQ BASELINE SEED END` markers, and
`npm run db:seed` executes exactly that block — so a local reset and a deployed seed run the
same statements rather than two copies that can drift.

The baseline seed is a transcription of the .NET startup seeders (`PermissionCatalog.cs` and
`DefaultReferenceData.cs`), which have no serverless equivalent. The integration suite
re-derives both inventories from those C# files and compares them row by row, so a typo in a
permission code or a status `canonical_key` fails the build.

**Idempotency.** Every statement is conflict-tolerant, and the whole block runs in one
transaction. Re-running converges: no duplicate rows, no errors, no partial application.
`permissions` rows are re-asserted on conflict (the catalog is code-owned); template rows are
left alone on conflict, because Internal users may have edited them and those edits win.

### Seeding a deployed environment

The same script is the deploy step (Q-8). It connects through `SUPABASE_DIRECT_DATABASE_URL` — never the
pooler — and takes the target environment from the loaded configuration, not from a flag.

A **non-local target refuses to run** unless you name it explicitly:

```bash
npm run db:seed                      # local: runs unattended
npm run db:seed -- --env=staging     # required for any non-local APP_ENV
```

Running it against a non-local database without `--env=<that environment>` exits non-zero and
changes nothing, so the seed can never run automatically in production. If the flag names a
different environment than the configuration resolves to, it also refuses — a stale
`--env=local` in your shell history cannot seed production.

### Demo seed

`npm run db:seed:demo` layers the full demo dataset on top of the baseline. It:

- provisions the demo personas in **local Supabase Auth** (Admin API, create-if-absent) and links
  each `users.auth_user_id`, so the e2e suite can sign in;
- inserts two tenants and their reference data, brokers, parties, leads, quotes, follow-ups,
  pricing approvals, status history and sample job runs, sized to at least the documented volumes;
- seeds **alert-triggering fixtures** for every alert type, then runs an alert evaluation so the
  Alerts Center is populated immediately;
- **verifies** counts and invariants (every quote has a lead, exactly one current version per quote,
  status/category consistency, all eleven alert types firing) and refuses to report success
  otherwise.

It is **idempotent**: it removes the previous demo layer (only demo tenants and rows above
`DEMO_ID_BASE`, never your own data) and reinserts with explicit ids, so re-running — or a reset
followed by two demo runs — converges to byte-identical state. Like the baseline seed it connects
through `SUPABASE_DIRECT_DATABASE_URL` and refuses a non-local target without `--env=<that environment>`, so
it never runs automatically in production.

```bash
npm run db:seed:demo                    # local: runs unattended
npm run db:seed:demo -- --env=staging   # required for any non-local APP_ENV
```

**Demo credentials (LOCAL / E2E ONLY — never a production secret).** Every demo persona signs in
with the password `test1234`, and every email ends in `@quoteiq.local` — sign in with the full
address, e.g. `internal.admin@quoteiq.local`. This is the complete set of sixteen (the code source
of truth is `scripts/db/demo-data/catalog.ts`). The two tenants are **Kalahari Insurance (Pilot)**
and **Okavango Risk Partners** (both currency BWP).

| Email (`…@quoteiq.local`) | Role | Tenant(s) | Notes |
| --- | --- | --- | --- |
| `internal.admin` | Internal Administrator | both + global | cross-tenant oversight; the only persona that sees Tenant Manager |
| `pilot.admin` | Tenant Administrator | Kalahari (Pilot) | tenant-scoped admin — no Internal-only nav |
| `sales.manager` | Sales Manager | both | two-tenant user; switch active tenant in the top bar |
| `executive` | Executive | Kalahari | dashboards / reporting |
| `rm.tebogo` | Relationship Manager | Kalahari | |
| `rm.lorato` | Relationship Manager | Kalahari | |
| `rm.mpho` | Relationship Manager | Kalahari | |
| `rm.single` | Relationship Manager | Kalahari | |
| `uw.thabo` | Underwriter | Kalahari | pricing approvals |
| `uw.gorata` | Underwriter | Kalahari | |
| `partner.admin` | Tenant Administrator | Okavango | |
| `partner.manager` | Sales Manager | Okavango | |
| `partner.rm1` | Relationship Manager | Okavango | |
| `partner.rm2` | Relationship Manager | Okavango | |
| `partner.uw` | Underwriter | Okavango | |
| `disabled.user` | Relationship Manager | Kalahari | **deactivated** — sign-in is refused, demonstrating deactivate-not-delete (AC-029) |

## Clean-checkout walkthrough (V-115)

This is the literal top-to-bottom sequence for AC-089 / V-115, from a pristine clone on a machine
with **only** Node 22, Docker, and the Supabase CLI (bundled — see [Prerequisites](#prerequisites)).
Every command is copy-paste and every one exists in `package.json`. No hosted service and no
network to `supabase.com` / `vercel.com` is required. Run the commands in order; each has an
explicit pass condition.

| # | Command | Pass condition |
| --- | --- | --- |
| 1 | `npm install` | Completes; installs the pinned Supabase CLI and workspaces. |
| 2 | `cp .env.local.example .env.local` | `.env.local` exists (git-ignored). |
| 3 | `npm run supabase:start` | Prints `API_URL`, `DB_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`. |
| 4 | Fill `.env.local` from step 3 (see [First-time setup](#first-time-setup)) | `ANON_KEY`, `SERVICE_ROLE_KEY`, and `postgres` for `<local-db-password>`. |
| 5 | `npm run supabase:reset` | All migrations replay from empty and `seed.sql` runs — no error. |
| 6 | `npm run db:seed:demo` | Provisions demo personas and data; reports success (counts + invariants verified). |
| 7 | `npm run dev` | API on :3001 and SPA on :5173 both start; no errors. |
| 8 | Open http://localhost:5173, sign in as `internal.admin@quoteiq.local` / `test1234` | Sign-in succeeds; leads list and a dashboard load with data through `/api/v1`. |
| 9 | `npm run test:unit` | Unit project passes. |
| 10 | `npm run test:integration` (needs the stack from step 3) | Integration project passes. |
| 11 | `npm test -w e2e_tests` (Playwright; needs the stack + demo seed + `npm run dev`) | e2e suite green. |

Notes:

- Steps 9–10 can be run together as `npm run ci:test` (asserts the expected total and fails on any
  skipped test), which is exactly how CI runs the backend suite.
- The e2e suite (step 11) is a workspace under `e2e_tests`; its full CI wiring is owned by T-043.
  The command above runs it locally against the running app.
- Any step that needs an undocumented action is a **findings-worthy doc gap** — record it, do not
  work around it silently.

## Platform notes

**Windows / Docker Desktop.** Verified on Windows 11 with Docker Desktop 29.1.3.

- Docker Desktop must be running before any `supabase:*` script; otherwise the CLI fails with
  a Docker connection error.
- Run the scripts through `npm run ...`. Invoking the CLI as `npx supabase ...` inside a Node
  child process fails with `EINVAL` on Node 22+ because Windows refuses to spawn `npx.cmd`
  without a shell; repository scripts call the CLI's JS entrypoint directly to avoid this.
- The stack binds to `0.0.0.0`, so the services are reachable from your local network. On an
  untrusted network, stop the stack when you are not using it.

## Continuous integration

[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)

> Replace `OWNER/REPO` in the badge above once the repository's GitHub remote is known. The
> badge is inert until then.

CI is GitHub Actions, defined in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). It
runs on every push, every pull request, and on demand. Everything happens in one job on one
runner: the backend integration suite needs the Supabase stack an earlier step starts, and the
suites are not safe to run concurrently against a single database.

Gates, in order (fail fast — cheapest first):

| # | Step | Command |
| --- | --- | --- |
| 1 | Install on **Node 22 LTS** | `npm ci` |
| 2 | Backend typecheck | `npm run typecheck` |
| 3 | SPA typecheck | `npm run typecheck:ui` |
| 4 | Backend lint | `npm run lint` |
| 5 | SPA lint | `npm run lint:ui` |
| 6 | SPA tests | `npm run ci:test:ui` |
| 7 | SPA production build | `npm run build:ui` |
| 8 | Start Supabase stack | `npm run supabase:start` |
| 9 | Migrations + baseline seed | `npm run supabase:reset` |
| 10 | Backend unit + integration tests | `npm run ci:test` |
| 11 | Migration-from-clean validation | `npm run db:validate` |

Node is pinned to 22 to match `engines.node` and the `nodejs22.x` runtime in `vercel.json`.
Do not float it to `lts/*`: the point is to exercise the version Vercel actually runs.

The Supabase CLI in CI is the one pinned in `devDependencies`, not `supabase/setup-cli`, so CI
and laptops run an identical CLI version. The Docker volume is deliberately **not** cached —
migration-from-clean is exactly what step 11 is testing.

### Why `ci:test` exists instead of plain `npm test`

Integration suites skip themselves when the local stack is unreachable and **still exit 0**
(see `src/server/tests/integration/helpers/local-stack.ts`). That is deliberate, so a laptop
without Docker is not blocked — but in CI, where the stack is always provisioned, a skip means
the pipeline would report green on tests that never ran. `scripts/ci/assert-test-run.ts` wraps
vitest, reads its JSON report, and fails if **any** test is skipped or if the total falls below
a floor (`--min-tests`). The floor catches the opposite failure: a suite that silently stops
being collected — a jsdom/hoisting regression has already caused exactly that here.

The count is a floor rather than an exact match on purpose. An exact count goes red every time
anyone legitimately adds a test, and a gate that cries wolf on correct work gets deleted. The
**zero-skip** assertion, not the count, is what turns an unavailable Supabase stack into a hard
failure. Raise the floor deliberately as the suites grow.

### Deployment automation (not enabled)

Deployment stays human-driven. `.github/workflows/ci.yml` ends with a commented-out `deploy`
job and the secrets it would need — `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, and
for hosted migrations `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`.
None of them are required for CI to pass. See [`deployment.md`](./deployment.md).

### End-to-end tests (Playwright)

The Playwright suite lives in the `e2e_tests` workspace and runs against the **running app + demo
seed** (T-043). Prerequisites, in order:

1. `npm run supabase:start` (Docker stack up).
2. `.env.local` filled with the real local keys from `npx supabase status` — including the two
   browser-safe `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` values the SPA needs. Placeholder
   values (`local-anon-key`, `local-service-role-key`) will fail: the demo seed's Auth Admin call
   and the SPA sign-in both need real keys.
3. The demo dataset. `global-setup.ts` applies the idempotent demo seed automatically before the
   run; set `E2E_RESET=1` to also `supabase db reset` first, or `E2E_SKIP_SEED=1` to skip when the
   data is already present.
4. The app. Playwright's `webServer` starts `npm run dev` (API :3001 + SPA :5173) and injects the
   `VITE_` Supabase values; `reuseExistingServer` reuses one you already have running locally.

Commands:

| Command | What it runs |
| --- | --- |
| `npm run test:e2e` | The full suite (`e2e_tests`, chromium project). |
| `npm run test:e2e:smoke` | The CI smoke subset only (`--project=smoke`: the auth surface — sign-in, sign-out, unauth redirect). |

Login strategy (Q-21): the login/logout specs drive the **real SPA `/sign-in` form** against local
Supabase Auth; every other spec uses an **admin-minted session** (`helpers/auth.ts` signs the
persona in server-side and injects the supabase-js session into `localStorage` before the SPA
boots) so it authenticates without a per-test form round trip. Personas and the shared demo
password come from the demo seed (`scripts/db/demo-data/catalog.ts`); `helpers/personas.ts` maps
the stable persona keys onto them. Deterministic job effects (alerts, expiry) are forced through
`helpers/jobs.ts`, which invokes the same `cron:run` / `queue:worker` handlers rather than waiting
on pg_cron.

**CI decision (T-043).** The per-PR CI gate is the **smoke subset**, not the full suite: the full
suite needs the live app + demo seed + a real browser driving long journeys and is too slow and,
at cutover, still carries per-spec data-reconciliation debt to gate every push on. `ci.yml` carries
a ready-to-enable `e2e_smoke` job (its own Supabase reset + demo seed + chromium) that runs
`npm run test:e2e:smoke`; enable it by uncommenting. The full suite is a local / on-demand run.

## Environment files

`.env.local.example` documents the local stack values; copy it to `.env.local`, which is
git-ignored. `.env.example` documents deployed-environment variables with placeholders only.
Never commit real keys. The authoritative variable catalog is `docs/environment-variables.md`
(finalized in T-042).
