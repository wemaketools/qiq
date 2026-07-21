# Cutover: legacy removal, deviation ledger, and Definition of Done

Status: legacy stack removed on the migration branch (T-044). This document is the durable record
that AC-093/AC-094/AC-095 and V-119–V-123 require to survive past cutover. It has four parts:

1. What was removed (AC-094 / V-121).
2. Repository hygiene sweep before/after (V-121).
3. The API-contract deviation ledger — the two headline deviations plus the accumulated
   target-only deviations and preserved-contract clarifications (AC-095 / V-123).
4. The Definition of Done checklist with per-item evidence and the items that remain
   human/cutover-time (AC-094 / V-122), and the metric-parity manual prerequisite (AC-093 /
   V-119 / V-120).

---

## 1. Legacy stack removal (AC-094 / V-121)

Removed with the filesystem (tracked files — the human's git will show them as deletions to
commit; that commit is the git-recoverable rollback anchor per spec §18):

| Removed | What it was |
|---|---|
| `src/api/` (761 tracked files) | The entire .NET solution (QuoteIQ.Api/Application/Domain/Infrastructure), its Liquibase changelogs under `db/`, and its .NET test projects. |
| `docker-compose.yml` | Brought up the retired local stack: Postgres-legacy, Keycloak, HashiCorp Vault, MinIO, and the one-shot Liquibase migrator. |
| `infra/keycloak/`, `infra/vault/` (the whole `infra/` tree) | Keycloak realm import + theme, and the Vault local-secret seeding script. |
| `README.dev.md` | The .NET/docker-compose developer guide. Superseded by `docs/local-development.md`. |
| `run.ps1` | One-command bring-up of the docker infra + Liquibase + `dotnet run` + SPA. Superseded by the `npm run` scripts. |
| `e2e_tests/seed/seed-shell-e2e.sh`, `e2e_tests/seed/seed-authz-e2e.sh` | Legacy e2e credential seeds that drove the Keycloak login form and `dotnet run -- seed`. The migrated e2e flow seeds via `e2e_tests/helpers/seed.ts` (Supabase) in `global-setup.ts`. |
| `src/server/tests/integration/schema-{foundation,business,reference}-dotnet-parity.test.ts` (15 tests) | Schema-shape comparisons against the live .NET/Liquibase reference DB over docker-compose. See §1a. |
| `src/server/tests/helpers/dotnet-seed-reference.ts` | Parsed the .NET C# sources at test time. Replaced by a frozen snapshot — see §1a. |

Approved backend runtime dependencies (unchanged, already exactly the allowed set):
`@supabase/supabase-js`, `exceljs`, `hono`, `kysely`, `pg`, `zod` (plus `tsx` in devDependencies).
No `oidc-client-ts`, no Hangfire/EF Core/Liquibase/Keycloak/Vault/MinIO client in any `package.json`.

### 1a. The schema-parity tests and the baseline-seed fixture

The three `schema-*-dotnet-parity.test.ts` suites validated the migrated Supabase schema against the
legacy .NET database over docker-compose. They had served their purpose (schema parity was proven
during the migration) and could only ever pass with the retired reference DB running — with it gone
they would `describe.skip`, which `assert-test-run.ts` (the "don't silently lose tests" guard)
treats as a hard failure. They were removed. The surviving schema guarantee is **`npm run
db:validate`**: it replays every migration from empty twice and diffs the result against the
checked-in `supabase/schema.expected.sql` snapshot.

Removing 15 tests lowered the deliberate `ci:test` floor **from 3746 to 3731** (`--min-tests` in the
`ci:test` script in `package.json`). This is the one place the floor was lowered, and only because
the tests are genuinely obsolete. New backend total: **3731 passed, 0 skipped**.

`dotnet-seed-reference.ts` derived the baseline-seed expectations (81 permissions, 93 reference
rows) from the .NET C# sources at test time so `supabase/seed.sql` could not silently drift. That
live derivation is impossible once `src/api` is gone, but the seed-content guarantee is **not**
covered by `db:validate` (which checks schema, not seed rows). So the exact inventory it produced
was captured verbatim into `src/server/tests/fixtures/baseline-seed-reference.json` and the helper
was reworked into `src/server/tests/helpers/baseline-seed-reference.ts`, which reads that frozen
snapshot. `baseline-seed.test.ts` still compares the fixture key-for-key against `seed.sql` and the
live database, so a drifted or mistyped seed row still fails loudly.

## 2. Repository hygiene sweep (V-121)

Scanned the live tree (excluding `node_modules`, `.git`, `.claude`, `package-lock.json`) for
`keycloak|hangfire|liquibase|minio|hashicorp|oidc-client|dotnet|.net|ef core`.

**Result: zero runtime references to any retired platform remain.** Verified specifically:

- No import/require of any legacy library (`oidc-client-ts`, keycloak/vault/minio clients): none.
- No connection to any legacy service port — Keycloak `:8080`, Vault `:8200`, MinIO `:9000`,
  legacy Postgres `:5432`: none. Every service URL now targets the Supabase local stack
  (`:54321` API, `:54322` DB, `:54324` inbox).
- No `dotnet` / `liquibase` / `docker compose up` process invocation in any script or test.

Every remaining textual hit is one of these allow-listed categories:

- **Migration-context comments** in the new code explaining a design decision or provenance
  ("replaces the Hangfire recurring jobs", "under Keycloak the token had already authenticated",
  "adding an S3/MinIO binding later", "Port of `src/api/QuoteIQ.Api/Auth/RequirePermissionFilter.cs`").
  The spec designates these as legitimate; they were kept.
- **Removal-guard tests** that assert the legacy is gone: `browserClientBoundary.test.ts` (no
  `oidc-client-ts` import or SPA dependency) and `repo-layout.test.ts` (asserts `src/api`,
  `docker-compose.yml`, `infra` are absent — inverted at cutover from the old "must be present" guard).
- **Frozen reference snapshots**: `problem.test.ts`'s captured `.NET` problem+json table and the
  `baseline-seed-reference.json` provenance — data captured from the reference, not a live link.
- **`docs/` and `spec.md`** historical mentions (allowed).
- **`CLAUDE.md`** instructional prohibitions ("Do not use EF Core", "Do not use Hangfire").
- A handful of **stale-but-harmless comment references** to the deleted `seed-shell-e2e.sh` in e2e
  spec docstrings (they explain why certain assertions are `fixme`'d for lack of seeded data; they
  contain no platform name and do not affect execution — the seed now runs from
  `e2e_tests/helpers/seed.ts`).

## 3. API-contract deviation ledger (AC-095 / V-123)

The migrated `/api/v1` surface preserves the existing paths, methods, DTO field names, pagination
shape (`{items,page,pageSize,total}`, default 25), sort/filter params, status codes, `problem+json`
shapes, warning payloads, and `availableOperations` — verified by the per-endpoint integration
contract assertions and the adapted e2e suite (both green in the final gate run). It is preserved
1:1 **except** the two documented deviations below, plus the accumulated target-only strengthenings
and clarifications that AC-095 requires to be written down here rather than reconstructed from the
event log.

### The two headline contract deviations (AC-095)

- **A-7 — attachment signed-URL envelope.** Upload/download go through a Supabase signed-URL
  request → direct-to-storage transfer → confirm flow instead of the .NET single-request byte
  stream. Paired consumer update: the SPA quote attachment flow (`QuotesCard` / quotes API).
- **Q-19 — intake API-key auth.** The public intake endpoint authenticates with an API key
  (`X-API-Key`) rather than the retired Keycloak bearer. Paired consumer update: the documented
  integrator header (see ledger entry 7 for the header-name caveat).

### Accumulated target-only deviations and preserved-contract clarifications

1. `uq_quotes_current` — a DB-level unique guard absent from the .NET reference, where the invariant
   lived only in the handlers, so two concurrent promotions could commit two current rows and
   double-count quoted premium in every dashboard joining `is_current`.
2. Reference-data `uq_reference_items_tenant_list_canonical_key`, likewise not in the reference schema.
3. `.strict()` write schemas and validated reorder bodies, where the reference ignored unknown keys
   and NRE'd into a 500.
4. T-020's int32-ceiling hardening, which returns a typed 422 where the reference accepted the value
   then 500'd in Postgres.
5. T-017's orphaned-identity compensation, a deliberate divergence from `CreateUserCommandHandler.cs:13-21`.
6. Intake rate limiting **DEFERRED** (Q-17/A-20) although the reference had a 429 policy at
   `IntakeEndpoints.cs:29` — **must be revisited before cutover.**
7. The intake `X-API-Key` header name, chosen rather than inherited (`spec.md:380` says only "a
   documented header") — becomes a breaking change once an integrator onboards.
8. The `availableOperations` field name vs the reference's `legalOperations` 409 hint field.
9. `GET /quotes/{id}/attachments` is an **API-surface addition** — the reference had no attachment
   list endpoint and `QuoteDto` carried no attachments field (the SPA tracked them in component
   state and lost them on reload). Added because AC-057/V-073's "disappears from the quote's list"
   is otherwise unverifiable; ruled correct because amending AC-057 would have preserved a defect.
10. The attachment **confirm** endpoint, likewise not in the reference, required by the signed-URL flow.
11. **Magic-number timing residual (R-8):** validation is implemented but its timing changed — the
    reference inspected bytes mid-stream so a bad file never reached storage; direct-to-storage means
    a hostile object exists between transfer and confirm. Verified unreachable in that window (bucket
    `public=false`, zero storage RLS policies, no signed URL for `confirmed_at IS NULL` rows, list
    excludes pending rows) and deleted on rejection — but "never written" has become "written, then deleted".
12. Upload-URL TTL is **fixed at 2h** by Supabase and cannot be shortened via the client API
    (`createSignedUploadUrl` takes no `expiresIn`); download expiry is ours and is set to 300s.
13. **First deliberate behavioural divergence (human decision, findings F-036-01/02, F-037-5).**
    Dashboard aggregates now narrow by `leads.view_all` breadth (the reference applied it only to
    drills), and drill-through applies the date filter per widget — only where that widget's aggregate
    is itself date-scoped. Rationale: an aggregate the user cannot reconcile by drilling into it is
    worse than a smaller aggregate. **User-visible at cutover:** users WITHOUT `leads.view_all` see
    SMALLER dashboard totals than the legacy system showed them, and that is intended. **This is a
    metric-parity exception** — the V-119/V-120 side-by-side check must be run as a `view_all`-holding
    caller or it will report a false regression.
14. **Second deliberate change to shipped numbers (F-050-07).** Pipeline's `sla_breaches` and five
    Immediate Actions previously read `countOpenAlertsByType` (tenant-wide, honouring neither the
    dashboard filter nor breadth) while their drill honoured both — structurally unreconcilable. They
    now count over the snapshot's own alert rows. **User-visible:** those six numbers narrow under a
    filter where they previously did not. The Alerts Centre's use of the same counter is untouched.
15. **Three reference drill scopes that excluded leads their own aggregate counted (F-050-07).**
    `openPipelineOf` sums open-category quotes but the reference scope filtered on LEAD category, so
    an open quote on a lost lead was dropped; `won_premium` likewise; `leads_at_risk` had no category
    test but the reference scope required an open category. Porting verbatim would have shipped
    superset violations, so each scope is now the UNION over every aggregate emitting its key. Each
    widening carries a test naming the lead the reference would have dropped.

No additional, undocumented deviation was found by the contract tests. Any future one must be raised
as a finding, never silently absorbed.

## 4. Definition of Done (AC-094 / V-122) and metric parity (AC-093)

Final gate run on the post-removal tree, DB reset to baseline:

| DoD item | Status | Evidence |
|---|---|---|
| No .NET/Hangfire runtime required to build or test | SATISFIED | Whole app builds and tests on Node + Supabase only; `src/api` and docker-compose removed; `npm run typecheck`, `lint`, `test`, `build:ui` all pass with no .NET toolchain. |
| TypeScript backend deployable to Vercel (build succeeds with documented placeholders) | SATISFIED (build) / HUMAN (deploy) | `npm run build:ui` succeeds; `vercel.json` present; `vercel-config.test.ts` green. Actual hosted deploy is human cutover-time (A-18). |
| Supabase Postgres is the source of truth | SATISFIED | `npm run db:validate`: all 28 migrations apply from empty twice, identical, and match `schema.expected.sql`. |
| Clean-checkout local dev works from docs | SATISFIED | `docs/local-development.md` is the runbook; `root-scripts.test.ts` / `env-examples.test.ts` green; `supabase:reset` + `db:seed:demo` verified this run. |
| All product capabilities pass the adapted e2e suite | SATISFIED (active suite) | Adapted Playwright suite: active specs green with 60 documented seed-data `fixme`s (T-043/T-052). Comment references to the deleted seed script are stale-but-harmless (§2); the suite seeds via `helpers/seed.ts`. |
| All jobs have working Supabase Cron/Queues impls, local + deployed paths | SATISFIED (local) / HUMAN (deployed firing) | Four jobs (overdue/stalled/expiring alerts, SLA/lead-inactivity, quote-expiry, orphaned-upload-reaper) run via `pg_cron` schedules + `pgmq`; integration tests exercise the local path. Deployed pg_cron firing is deferred to post-cutover QA (V-082/V-085). |
| Tenant isolation and RBAC validated by tests | SATISFIED | Integration suites (tenant-context, require-permission, effective-permissions) + e2e (role-403-sweep, internal-cross-tenant, tenant-isolation) green. |
| All four docs complete | SATISFIED | `docs/local-development.md`, `docs/environment-variables.md`, `docs/deployment.md`, `docs/background-jobs.md` present; `repo-layout.test.ts` asserts all four. |

### Metric parity (AC-093 / V-119 / V-120) — HUMAN cutover-time prerequisite

Per the human sequencing ruling (2026-07-21), the automated metric-parity run was **skipped** and is
recorded here as a **manual human cutover-time prerequisite**, to be run BEFORE the legacy branch is
retired:

- Load the identical demo seed into the legacy .NET stack (still recoverable in git history) and the
  migrated stack; capture every KPI/total on all five dashboards for a fixed filter set from both and
  diff them; exact match, no tolerance.
- **Run it as a `leads.view_all`-holding caller** — ledger entry 13 means a restricted caller will
  legitimately show smaller totals on the new stack, which a naive comparison would misreport as a
  regression.
- Store the captured payload pairs as permanent cutover evidence (after removal this can only be run
  from the git-recoverable legacy branch).

### Other human/cutover-time items (not satisfied-by-implementation)

- **F-051-1** — the migrated tree is currently untracked, so `ci:security` (which scans **tracked**
  files) scanned the OLD tracked set this run (427 files, 0 secrets; SPA bundle 0 leaks — green). The
  human must commit the deletions + the new tree and re-run `ci:security` so V-003/V-114 sign off
  against the real target tree.
- Hosted Supabase/Vercel provisioning and the real cutover execution (A-18).
- Deployed pg_cron firing and deployed smoke tests (V-082/V-085).
- Intake rate limiting (ledger entry 6) must be revisited before cutover.
