#!/usr/bin/env tsx
/**
 * `npm run cron:run:all` — run every cron sweep once, locally (T-031, AC-065, spec §9.5).
 *
 * The local stand-in for "all three pg_cron schedules have fired". Used to exercise the full sweep
 * set after a reset/seed without waiting on real schedules, and as the local rehearsal for what the
 * deployed schedules do.
 *
 * Runs sweeps SEQUENTIALLY, not concurrently: they share a small pooler-safe connection pool
 * (max 2), and alert reconciliation reads state the expiry sweeps write, so overlapping them would
 * make the outcome ordering-dependent. Deployed, the schedules are offset for the same reason.
 *
 * Every job is attempted even if an earlier one fails — a single broken sweep should not hide the
 * status of the others — and the command exits non-zero if ANY sweep failed.
 */
import { closeDb } from '../../src/server/lib/db/index.js';
import { CRON_JOB_NAMES } from '../../src/server/jobs/cron/registry.js';
import { createJobRuntime } from '../../src/server/jobs/runtime.js';

/** Scripts print through stdout directly: the lint config allows only console.warn/error. */
function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Diagnostics go to stderr so stdout stays parseable. */
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function main(): Promise<void> {
  const runtime = createJobRuntime();
  const failures: string[] = [];

  try {
    for (const jobName of CRON_JOB_NAMES) {
      const outcome = await runtime.runCron({ jobName, trigger: 'manual' });
      out(
        `[cron:run:all] ${outcome.jobName}: ${outcome.status} ` +
          `(job_run ${String(outcome.jobRunId)})` +
          (outcome.counts ? ` counts=${JSON.stringify(outcome.counts)}` : ''),
      );
      if (outcome.status === 'failed') {
        failures.push(`${outcome.jobName}: ${String(outcome.error)}`);
      }
    }
  } finally {
    await closeDb();
  }

  if (failures.length > 0) {
    err(`\n[cron:run:all] ${String(failures.length)} of ${String(CRON_JOB_NAMES.length)} sweep(s) FAILED:`);
    for (const failure of failures) err(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  out(`\n[cron:run:all] all ${String(CRON_JOB_NAMES.length)} sweep(s) succeeded.`);
}

await main();
