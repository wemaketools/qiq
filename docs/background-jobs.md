# Background Jobs

This is the M-18 job runbook: every cron and queue job, its schedule, both consumption paths
(the deployed `pg_cron → pg_net → endpoint` hop and the local `npm run cron:run*` /
`npm run queue:worker` substitutes), idempotency, retry/failure behaviour, and the inspection and
manual-run procedures. It is kept consistent with the live migrations in `supabase/migrations/`.

## Scheduling model (M-14 / M-22 / Q-7)

**`vercel.json` never contains a `crons` key.** Scheduling is owned by the database:
`pg_cron` jobs defined in `supabase/migrations/` call the secret-protected endpoints under
`api/cron/` and `api/queue/drain.ts` over HTTP via `pg_net`. This applies to both deployed
and local environments; a regression test (`src/server/tests/integration/vercel-config.test.ts`)
fails the build if a `crons` key is ever added to `vercel.json`.

Locally, the deterministic documented path is `npm run cron:run <job>` / `npm run cron:run:all`
plus `npm run queue:worker`, all running the same handler code as the deployed endpoints.

To be documented per job when implemented: job name, purpose, `pg_cron` schedule, queue
name and message type, idempotency key strategy, retry and failure behavior, required
database state (`job_run` rows), and observability expectations.

## Recurring jobs

| Job | Schedule (UTC) | Endpoint | Owner |
| --- | --- | --- | --- |
| `quote-expiry` | `0 * * * *` | `/api/cron/quote-expiry` | T-032 |
| `lead-inactivity-expiry` | `10 * * * *` | `/api/cron/lead-inactivity-expiry` | T-032 |
| `alert-evaluation` | `*/15 * * * *` | `/api/cron/alert-evaluation` | T-034 (handler by T-033) |
| `queue-drain` | `* * * * *` | `POST /api/queue/drain` | T-034 |

All three sweeps are registered handlers as of T-034; `npm run cron:list` reports them and
`npm run cron:run:all` exits zero.

The ten-minute offset between the two expiry sweeps is deliberate. The quote sweep stamps
`last_activity_at` on every lead whose quote it expires, so running both on the same minute would
have the inactivity sweep reading a column the other job is still writing.

### Job 1 — `quote-expiry`

- **Purpose.** Move every `Sent` **or `Revised`** quote whose `valid_until` has passed to `Expired`.
  When the tenant has `expire_lead_when_last_quote_expires` enabled *and* the lead has no other open
  quote, also expire the lead.
- **Predicate.** `valid_until IS NOT NULL AND valid_until < today(UTC) AND canonical_key IN
  ('sent','revised')`. Strictly `<`: a quote valid *through* today is still valid today.
- **Idempotency key.** None, deliberately. The sweep is **state-guarded** — expiring a quote removes
  it from the candidate set, so a second run selects nothing and writes nothing. A missed tick
  self-heals on the next one.
- **Retry / duplicate delivery.** Safe at any time. Each quote is expired in its own transaction
  which re-reads it and re-checks the legality matrix, so two overlapping runs cannot both expire the
  same quote.
- **Failure handling.** Per tenant *and* per quote. One tenant throwing does not stop the sweep; one
  quote failing does not abandon the rest of its tenant's candidates. The run reports `failed` with
  the failing tenant ids and partial counts in `job_run.error_message`.
- **Database state.** Writes `quotes.status_id`, `quote_status_history`, `leads`,
  `lead_status_history`, `audit_log` — all through the shared workflow executors, never by hand.
- **Observability.** One log line per tenant (`quotesExpired`, `leadsExpired`, `quotesFailed`), a
  warning per failed quote, aggregate counts on `job_run.counts`.

### Job 2 — `lead-inactivity-expiry`

- **Purpose.** Move every open/quoted lead whose `last_activity_at` is older than the tenant's own
  `lead_inactivity_expiry_days` to `Expired`.
- **Predicate.** `last_activity_at IS NOT NULL AND last_activity_at < (now - N days) AND
  reporting_category IN ('open','quoted')`. Note this keys off the reporting **category**, not a
  canonical-key list, so a tenant's own intermediate open status does age out.
- **Quote activity counts as lead activity.** The job never re-derives activity: every quote
  operation stamps the parent lead's `last_activity_at`, so the column is already the union of lead
  and quote activity when the sweep reads it.
- **Idempotency key.** None — same state-guarded argument as Job 1.
- **Failure handling / observability.** As Job 1, with `leadsExpired` / `leadsFailed`.

Together these two are the **only** automatic status changes in the product (P-07).

### Configuring the deployed pg_cron → pg_net hop

The schedules call `public.invoke_cron_endpoint('<job>')`, which reads the single-row table
`public.job_cron_config` (`base_url`, `cron_secret`) and issues a `pg_net` GET with an
`Authorization: Bearer <secret>` header.

**No URL and no secret is committed.** The table is created empty by migration and populated
**out of band per environment** — never by a migration and never by the committed seed. When it is
empty the helper raises a `NOTICE` and returns, which is the expected local state: locally the
sweeps are driven by `npm run cron:run -- <job>`, because `pg_net` runs inside the Supabase
container and cannot reach a dev server on the host (Q-7).

```sql
-- Run once per deployed environment, as the service role.
insert into public.job_cron_config (base_url, cron_secret)
values ('https://<your-deployment-host>', '<the CRON_SECRET value>')
on conflict (id) do update
   set base_url = excluded.base_url,
       cron_secret = excluded.cron_secret,
       updated_at = now();
```

This mechanism was chosen over `ALTER DATABASE ... SET app.settings.*` (not reliably visible to
pg_cron's background workers on Supabase, and undiagnosable when misconfigured) and over Supabase
Vault (Q-23 defers database-resident secrets; adopting it for one job schedule would pre-empt that
decision product-wide). The table is revoked from `public`, `anon` and `authenticated` — and, verified
against the live database, from `service_role` as well: it has no `SELECT`. Only the `postgres`
superuser and the `SECURITY DEFINER` function `invoke_cron_endpoint` (search_path pinned to
`public, extensions`) can read the secret. The migration's own `COMMENT ON TABLE` still says
"service-role only", which is inaccurate in the safe/more-restrictive direction; it is left as-is
because that migration is already applied and this repo does not edit applied migrations — correct it
in a later migration if the wording matters (evaluator finding F-032-6).

## Job infrastructure (T-031)

### Durable state

| Object | Purpose |
| --- | --- |
| `job_run` | One row per execution ATTEMPT: job name, trigger (`cron`/`queue`/`manual`), environment, correlation id, start/finish/duration, status, error detail, counts. Replaces the Hangfire dashboard and job store. |
| `job_idempotency_key` | Claimed dedupe keys for queue messages. Claimed in the same transaction as the handler effect. |
| pgmq `alert_reevaluation` | The durable queue (`pgmq.q_alert_reevaluation`) and its dead-letter archive (`pgmq.a_alert_reevaluation`). |

### Queue lifecycle

`pgmq.send` (enqueue) → `pgmq.read` with a visibility timeout (delivery; increments `read_ct`) →
handler → `pgmq.delete` (ack). A failed handler leaves the message unacked and re-hides it for the
retry delay; after `max_attempts` (default 5 deliveries) it is moved to the archive by
`pgmq.archive` and never delivered again. An unparseable message is archived on first sight — it
cannot become valid — whereas an unknown message *type* is retried, because during a rolling
deploy a producer can legitimately be ahead of the consumer.

### Idempotency (why duplicate delivery is safe)

pgmq is at-least-once. Per message the drain loop runs, in ONE transaction:

1. claim the idempotency key (`INSERT ... ON CONFLICT DO NOTHING`),
2. run the handler (writing through that same transaction),
3. ack the message.

Commit publishes all three or none. A duplicate finds the key already claimed and skips the
handler (`job_run.counts = {"duplicate": 1}`); a failed attempt rolls the claim back with the
effect, so the retry genuinely re-runs the work instead of silently skipping it. Handlers must
therefore write only through `context.db`, and must not keep state in module scope — serverless
instances are not long-lived.

### Endpoint protection

`/api/queue/drain` (`INTERNAL_JOB_SECRET`) and `/api/cron/{job}` (`CRON_SECRET`) validate the
`Authorization` header — `Bearer <secret>` or a bare secret — before touching the database, using a
constant-time comparison of SHA-256 digests. A rejection returns an identical 401 problem document
whether the secret was missing or wrong, logs only the reason (never the value), and leaves no
trace: no `job_run` row, no queue read, no mutation. Secrets are read only through the typed config
module.

### Job 3 — `alert-evaluation`

- **Schedule.** `*/15 * * * *` UTC, `pg_cron` → `pg_net` → `GET /api/cron/alert-evaluation`.
- **Purpose.** Make the `alerts` table equal the rule-match set for every active tenant.
- **Idempotency key.** None, deliberately: state-guarded reconciliation. See
  `src/server/jobs/cron/alert-evaluation.ts`.
- **Safety-net role.** This sweep is what makes Job 4's publish side fire-and-forget. A targeted
  message that is lost, dead-lettered, or never published converges here within 15 minutes.
- **Failure handling.** Per tenant; one tenant throwing does not stop the others, and the run
  reports FAILED with the failing tenant ids.

### Job 4 — `alert.reevaluate-lead` (queued)

- **Trigger.** Published by the lead and quote workflow executors AFTER their transaction commits —
  including the executors the two expiry sweeps drive, which is how an automatic expiry refreshes
  its lead's alerts (parity with the reference, where both executors enqueued the same way).
- **Consumer schedule.** The `queue-drain` entry above, every minute. There is no resident worker on
  Vercel (Q-7), so that schedule *is* the worker's heartbeat and it bounds how long a completed
  action's alert stays visible.
- **Payload.** `{ leadId }`; the tenant travels on the envelope. Ids only — the handler re-reads
  current state.
- **Idempotency key.** `{leadId}:{eventKey}`, where `eventKey` is the database identity of the
  change: the `lead_status_history.id` for a lead operation (so the key is literally
  `{leadId}:{statusHistoryId}`), `qsh:{quote_status_history.id}` for a quote operation, and
  `quote:{quoteId}` for quote creation. **The key must be unique per event, not per lead** — the
  drain loop skips a message whose key is already claimed, so a per-lead key would permanently drop
  every re-evaluation after the first.
- **Retry / duplicate delivery.** Safe. The handler is `evaluateForLead`, which reconciles rather
  than appends, and `uq_alerts_open_per_type_lead_quote` is the database-level backstop.
- **Failure handling.** Retry with delay up to `max_attempts`, then archived with a failed
  `job_run` row. Losing the message is not a correctness failure — Job 3 converges the same set.
- **Publish failures never fail the user's operation.** The operation is already durable when the
  seam runs; the failure is logged and the sweep picks it up.
- **Observability.** One `job_run` row per delivery carrying the originating request's correlation
  id, plus `created`/`resolved`/`matched` counts. Ids and counts only.

### Configuring the schedules in a deployed environment

`public.job_cron_config` is a single-row table, created EMPTY by migration and populated out of
band per environment. **No URL and no secret is ever committed.** It needs three values:

| Column | Value |
| --- | --- |
| `base_url` | Deployment origin, no trailing slash. |
| `cron_secret` | The environment's `CRON_SECRET` (used by `/api/cron/*`). |
| `internal_job_secret` | The environment's `INTERNAL_JOB_SECRET` (used by `/api/queue/drain`). |

Two separate secrets on purpose: a leak of one must not authorize the other. While the table is
empty — the normal local state — both helpers raise a NOTICE and return, and the local paths
(`npm run cron:run`, `npm run queue:worker`) are used instead, because `pg_net` runs inside the
Supabase container and cannot reach a dev server on the host (Q-7).

> **pg_net lives in the `net` schema.** Its functions are `net.http_get` / `net.http_post` even
> though the extension is registered in `extensions`. `invoke_cron_endpoint` originally called
> `extensions.http_get`, which does not exist, so every deployed sweep would have failed at its
> scheduled minute; fixed in `20260720010000_pg_cron_alert_and_drain_schedules.sql`. The schedule
> tests now execute both helpers rather than only inspecting their source.

#### Standing rule: execute SECURITY DEFINER extension calls, do not inspect their source

The `extensions.http_get` defect above passed **three** review layers (implementation,
evaluation, orchestrator snapshot) because every assertion inspected the helper's source text
(`prosrc` contained the expected path) or the `cron.job` rows — neither of which requires the
function to resolve, let alone run. So:

**Any `SECURITY DEFINER` function that invokes an extension function must have an integration test
that EXECUTES it** (against a rolled-back fixture row when it has side effects), not one that only
inspects `prosrc` / `pg_proc` source text or catalog rows. Source inspection cannot distinguish a
resolvable call from an unresolvable one. `pg-cron-schedules.test.ts` now executes both
`invoke_cron_endpoint` and `invoke_queue_drain`.

**Fix-forward history (so a future reader of the original migration is not misled).** This repo
never edits applied migrations. The original T-032 migration
`20260720000000_pg_cron_expiry_schedules.sql` **still literally contains**
`perform extensions.http_get(...)`; it is corrected forward by the T-034 migration
`20260720010000_pg_cron_alert_and_drain_schedules.sql`, which `CREATE OR REPLACE`s the helper with
`net.http_get` before `job_cron_config` is ever populated. On a clean apply the broken function is
created and then replaced within the same run, so the transient broken state is unreachable and
`npm run db:validate` confirms convergence. Read the T-034 migration's header for the resolution.

### Time budget

Vercel functions are time-bounded (`maxDuration` 60 for these routes). `drain()` processes bounded
batches and stops accepting new messages once its budget (default 25s) is spent. Messages already
read but not processed simply become visible again when their visibility timeout lapses, and the
next invocation takes them — a handler is never aborted mid-flight to meet a deadline. Each message
is attempted at most once per invocation, so a failing message cannot burn all five attempts in one
pass.

### Local commands

| Command | Purpose |
| --- | --- |
| `npm run queue:enqueue:test` | Inject a message (defaults to the `job.echo` smoke handler). `--key` twice demonstrates duplicate suppression. |
| `npm run queue:worker` | Drain the local queue through the same handler code as the endpoint. `--once` / `--idle-exit` for scripted use. |
| `npm run jobs:status` | `job_run` history, failures in the last 24h, stale `running` rows, and queue backlog / oldest-message age / dead-letter count. `--json` for machine-readable output. |

| `npm run cron:list` | List the known cron jobs and whether each has a registered handler. |
| `npm run cron:run -- <job>` | Run one sweep now through the same object graph as the endpoint (`job_run.trigger = 'manual'`). |
| `npm run cron:run:all` | Run every sweep. Exits zero now that all three are registered (T-034). |

### Not yet verifiable locally

The deployed path — `pg_cron` firing `pg_net` HTTP calls at the Vercel endpoints — cannot be
exercised from the local stack (pg_net runs inside Docker and would have to reach the host). It is
post-cutover manual QA. Everything on this page other than that hop is covered by
`src/server/tests/integration/pgmq-queue.test.ts`, `job-endpoints.test.ts` and `job-scripts.test.ts`.
