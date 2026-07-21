#!/usr/bin/env tsx
/**
 * `npm run cron:list` and `npm run cron:run <job>` — the LOCAL cron path (T-031, AC-065, spec §9.5).
 *
 * Deployed, each sweep is invoked by a pg_cron schedule calling `/api/cron/{job}` through pg_net.
 * Locally that callback cannot work — pg_net runs inside the Supabase container while the dev
 * server runs on the host — so Q-7 makes this script the deterministic local substitute.
 *
 * It runs through `createJobRuntime().runCron(...)`, the SAME object graph the endpoint uses, so
 * "the local path runs the same handler code" is a property of the import graph rather than a claim
 * in a comment. The only permitted difference is the `trigger` stamped on the job_run row:
 * 'manual' here, 'cron' from the endpoint.
 *
 * Until T-032/T-034 register handlers this exits NON-ZERO with HandlerNotRegisteredError and writes
 * a FAILED job_run row — deliberately matching the endpoint's loud 501 scaffold. A cheerful exit 0
 * for work nobody has written is how a missing sweep survives to production.
 *
 * Usage:
 *   npm run cron:list                     list the known cron jobs and whether a handler is registered
 *   npm run cron:run -- quote-expiry      run one sweep now
 */
import { closeDb } from '../../src/server/lib/db/index.js';
import { CRON_JOB_NAMES, cronHandlers, isCronJobName } from '../../src/server/jobs/cron/registry.js';
import { createJobRuntime } from '../../src/server/jobs/runtime.js';

/** Scripts print through stdout directly: the lint config allows only console.warn/error. */
function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Diagnostics go to stderr so stdout stays parseable. */
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Populates the handler registry so the listing reflects reality.
 *
 * Handlers register inside `createJobRuntime` — they are factories over the client that composition
 * root resolves — so a listing that never built one would report every sweep as unregistered even
 * in production, which is worse than no listing at all: it says the thing an operator is checking
 * for is broken when it is not.
 *
 * Building the runtime issues NO query (the pg Pool connects lazily), so `cron:list` still touches
 * no database. It CAN throw when configuration is absent, and that is caught rather than fatal: the
 * list of known job names is useful on its own, and a missing `.env.local` must not stop a developer
 * discovering what the jobs are called.
 */
function ensureHandlersRegistered(): void {
  try {
    createJobRuntime();
  } catch {
    err('[cron:list] could not load configuration; showing names only.\n');
  }
}

function listJobs(): void {
  ensureHandlersRegistered();

  out('Known cron jobs (name — handler status):');
  for (const name of CRON_JOB_NAMES) {
    const registered = cronHandlers.get(name) !== undefined;
    out(`  ${name} — ${registered ? 'registered' : 'NOT REGISTERED'}`);
  }
  out('\nRun one with:  npm run cron:run -- <job>');
  out('Run all with:  npm run cron:run:all');
}

async function main(): Promise<void> {
  // `npm run cron:run -- <job>` puts the job name after the `--` separator, which npm strips.
  const argv = process.argv.slice(2).filter((arg) => arg !== '--');
  const listOnly = argv.includes('--list') || argv.length === 0;

  // Both listing paths now build a runtime (see `ensureHandlersRegistered`), which creates a lazy
  // pool — so both must close it or the process hangs holding an idle pool open.
  if (listOnly) {
    try {
      listJobs();
    } finally {
      await closeDb();
    }
    return;
  }

  const jobName = argv[0] ?? '';
  if (!isCronJobName(jobName)) {
    err(`Unknown cron job "${jobName}".\n`);
    try {
      listJobs();
    } finally {
      await closeDb();
    }
    process.exitCode = 1;
    return;
  }

  const runtime = createJobRuntime();
  try {
    const outcome = await runtime.runCron({ jobName, trigger: 'manual' });
    out(
      `[cron:run] ${outcome.jobName}: ${outcome.status} ` +
        `(job_run ${String(outcome.jobRunId)}, correlationId ${outcome.correlationId})` +
        (outcome.counts ? ` counts=${JSON.stringify(outcome.counts)}` : ''),
    );
    if (outcome.status === 'failed') {
      // A failed sweep must fail the command, or a broken job looks green in a local check and in
      // any script that chains off it.
      err(`[cron:run] ${outcome.jobName} FAILED: ${String(outcome.error)}`);
      process.exitCode = 1;
    }
  } finally {
    await closeDb();
  }
}

await main();
