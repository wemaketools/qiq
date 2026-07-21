#!/usr/bin/env tsx
/**
 * `npm run jobs:status` — the Hangfire dashboard's replacement (T-031, A-15, AC-065, spec §9.4).
 *
 * Hangfire shipped a web UI showing what ran, what failed and what is queued. On Vercel there is no
 * process to host such a UI and no in-memory state to show, so the equivalent is a query over the
 * durable tables this task added plus pgmq's own metrics:
 *
 *   - recent job_run rows (what ran, how long it took, what it did)
 *   - failures in the last 24h grouped by job (what is broken)
 *   - runs still marked `running` well past any plausible duration (what died mid-flight — on
 *     Vercel a killed function never gets to write its own failure row, so a stale `running` row
 *     IS the failure signal)
 *   - queue backlog, oldest message age and dead-letter archive count (what is stuck)
 *
 * Usage:
 *   npm run jobs:status
 *   npm run jobs:status -- --limit 50 --job quote-expiry --json
 */
import { sql } from 'kysely';

import { closeDb } from '../../src/server/lib/db/index.js';
import { createJobRuntime } from '../../src/server/jobs/runtime.js';

interface RunRow {
  readonly id: number;
  readonly job_name: string;
  readonly trigger: string;
  readonly environment: string;
  readonly status: string;
  readonly started_at: Date | string;
  readonly duration_ms: number | null;
  readonly attempt: number;
  readonly correlation_id: string;
  readonly error_class: string | null;
  readonly error_message: string | null;
  readonly counts: unknown;
}

interface FailureRow {
  readonly job_name: string;
  readonly failures: number;
}

interface StaleRow {
  readonly id: number;
  readonly job_name: string;
  readonly started_at: Date | string;
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function numberFlag(argv: readonly string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  if (index === -1) return fallback;
  const parsed = Number(argv[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const limit = numberFlag(argv, '--limit', 20);
  const jobFilterIndex = argv.indexOf('--job');
  const jobFilter = jobFilterIndex === -1 ? undefined : argv[jobFilterIndex + 1];
  const asJson = argv.includes('--json');

  const runtime = createJobRuntime();
  const { db } = runtime;

  let runsQuery = db
    .selectFrom('job_run')
    .select([
      'id',
      'job_name',
      'trigger',
      'environment',
      'status',
      'started_at',
      'duration_ms',
      'attempt',
      'correlation_id',
      'error_class',
      'error_message',
      'counts',
    ])
    .orderBy('started_at', 'desc')
    .limit(limit);
  if (jobFilter !== undefined) runsQuery = runsQuery.where('job_name', '=', jobFilter);
  const runs = (await runsQuery.execute()) as unknown as readonly RunRow[];

  const failures = (await db
    .selectFrom('job_run')
    .select(['job_name'])
    .select(sql<number>`count(*)::int`.as('failures'))
    .where('status', '=', 'failed')
    .where(sql<boolean>`started_at > now() - interval '24 hours'`)
    .groupBy('job_name')
    .orderBy('failures', 'desc')
    .execute()) as unknown as readonly FailureRow[];

  // A run left as `running` is not "in progress" once it is older than any function's maxDuration:
  // it is a process that was killed before it could record its own failure.
  const stale = (await db
    .selectFrom('job_run')
    .select(['id', 'job_name', 'started_at'])
    .where('status', '=', 'running')
    .where(sql<boolean>`started_at < now() - interval '15 minutes'`)
    .orderBy('started_at', 'asc')
    .limit(20)
    .execute()) as unknown as readonly StaleRow[];

  const metrics = await runtime.transport.metrics();

  if (asJson) {
    out(JSON.stringify({ runs, failures24h: failures, stale, queue: metrics }, null, 2));
    await closeDb();
    return;
  }

  out(`QuoteIQ job status (environment: ${runtime.config.appEnv})`);
  out();
  out(`QUEUE ${metrics.queueName}`);
  out(`  backlog:           ${metrics.queueLength}`);
  out(`  oldest message:    ${metrics.oldestMessageAgeSeconds ?? '-'}s`);
  out(`  dead-letter total: ${metrics.archivedCount}`);
  out();
  out(`RECENT job_run (${runs.length} row(s)${jobFilter === undefined ? '' : `, job=${jobFilter}`})`);
  if (runs.length === 0) {
    out('  (none)');
  }
  for (const run of runs) {
    const duration = run.duration_ms === null ? '-' : `${run.duration_ms}ms`;
    out(
      `  #${run.id} ${iso(run.started_at)} ${run.job_name} [${run.trigger}/${run.environment}] ` +
        `${run.status} ${duration} attempt=${run.attempt} corr=${run.correlation_id}`,
    );
    if (run.counts !== null && run.counts !== undefined) out(`      counts: ${JSON.stringify(run.counts)}`);
    if (run.error_message !== null) out(`      error:  ${run.error_class}: ${run.error_message}`);
  }
  out();
  out('FAILURES (last 24h)');
  if (failures.length === 0) out('  (none)');
  for (const failure of failures) out(`  ${failure.job_name}: ${failure.failures}`);
  out();
  out('STALE RUNS (status=running for over 15 minutes — likely killed mid-flight)');
  if (stale.length === 0) out('  (none)');
  for (const row of stale) out(`  #${row.id} ${row.job_name} started ${iso(row.started_at)}`);

  await closeDb();
}

await main();
