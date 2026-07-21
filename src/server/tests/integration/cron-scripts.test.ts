/**
 * Local cron scripts (T-031, AC-065, V-082).
 *
 * Spec §9.5 requires a local substitute for the deployed pg_cron -> pg_net -> /api/cron/{job} path,
 * because pg_net runs inside the Supabase container and cannot call a dev server on the host. These
 * tests invoke the real npm scripts as a developer would — child processes, real `.env.local`, real
 * database — and assert the durable `job_run` evidence rather than console text, so a script that
 * printed a convincing summary while writing nothing would fail here.
 *
 * REGISTRATION STATE: complete as of T-034. All three sweeps now reach a real handler, so
 * `cron:run:all` exits ZERO. That transition is the whole point of the registration assertions
 * below, and they are written against `CRON_JOB_NAMES` rather than a hard-coded list so the
 * property they encode is "every sweep the application knows about has a handler", not "these three
 * strings appear".
 *
 * WHAT MUST NOT HAPPEN HERE: `cron:list` must never become a blanket "everything is fine". It reads
 * the REAL registry, so a name added to `CRON_JOB_NAMES` without a handler still reports NOT
 * REGISTERED and still fails this file — which is the signal an operator needs, and the reason the
 * assertion is on the registry's own output rather than on a list maintained beside it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../lib/db/index.js';
import { CRON_JOB_NAMES } from '../../jobs/cron/registry.js';
import { probeLocalStack, suiteTitle } from './helpers/local-stack.js';
import { runNpmScript } from './helpers/repo.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('local cron scripts', probe);

describeStack(title, () => {
  let handle: DbHandle;

  beforeAll(() => {
    if (!probe.available) return;
    handle = createDb({ connectionString: probe.stack.dbUrl });
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('cron:list names every known job without touching the database', async () => {
    const result = runNpmScript('cron:list');

    expect(result.status).toBe(0);
    // Every contract name must be listed: the URL path, job_run.job_name and the pg_cron entry all
    // key off these, so a name missing here means an operator cannot discover the job exists.
    for (const name of CRON_JOB_NAMES) {
      expect(result.output).toContain(name);
    }
  });

  it('cron:run rejects an unknown job name instead of inventing a run', async () => {
    const before = await countJobRuns(handle, 'definitely-not-a-job');
    const result = runNpmScript('cron:run -- definitely-not-a-job');

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('Unknown cron job');
    // A rejected name must not leave history behind, or job_run stops being a record of real work.
    expect(await countJobRuns(handle, 'definitely-not-a-job')).toBe(before);
  });

  /**
   * WHY THESE ASSERT "THE REGISTERED HANDLER RAN" RATHER THAN "THE SWEEP SUCCEEDED"
   * ==============================================================================
   * Both sweeps walk EVERY active tenant in the database, and a tenant with no `tenant_settings`
   * row is a per-tenant failure by design. On a shared local stack that estate includes whatever
   * other suites have in flight, so asserting `status = 'succeeded'` here would make this file fail
   * whenever an unrelated suite happened to hold an unprovisioned tenant mid-run — a flake with
   * nothing to do with the local cron path.
   *
   * What this file is actually for (AC-065, V-082) is that `cron:run` reaches the SAME registered
   * handler as the endpoint. `error_class !== 'HandlerNotRegisteredError'` plus real per-tenant
   * counts prove exactly that, and are independent of the estate. Sweep CORRECTNESS is pinned
   * against controlled fixtures in `quote-expiry-job.test.ts` / `lead-inactivity-job.test.ts`.
   */
  it.each(['quote-expiry', 'lead-inactivity-expiry'])(
    'cron:run executes the registered %s handler and records a job_run row',
    async (jobName) => {
      const before = await countJobRuns(handle, jobName);
      runNpmScript(`cron:run -- ${jobName}`);

      expect(await countJobRuns(handle, jobName)).toBe(before + 1);

      const latest = await latestJobRun(handle, jobName);
      // 'manual' is the ONLY difference spec §9.5 permits between the local and deployed paths.
      expect(latest?.trigger).toBe('manual');
      // The handler exists and ran. This is the assertion T-032 flipped: before registration it was
      // 'HandlerNotRegisteredError' with a 501 twin on the endpoint.
      expect(latest?.error_class).not.toBe('HandlerNotRegisteredError');

      // Per-tenant counts prove the sweep BODY executed rather than the runner merely bookkeeping a
      // row. They live in `counts` on a clean run and in `error_message` on a PARTIAL failure,
      // because `runCronJob` records counts only on the success path — so both are accepted here.
      // Which of the two occurs depends on whether any OTHER suite happens to be holding an
      // unprovisioned tenant while this runs, which is not this test's business.
      const evidence = `${JSON.stringify(latest?.counts)}${latest?.error_message ?? ''}`;
      expect(evidence).toContain('tenantsProcessed');
    },
  );

  it('cron:list reports EVERY known sweep as registered (T-034 completes the set)', async () => {
    const result = runNpmScript('cron:list');

    expect(result.status).toBe(0);
    // The registration seam is discoverable: an operator can see which sweeps actually have a
    // handler behind them, which is the difference between a scheduled job and a scheduled 501.
    //
    // This is also the guard against a whole sweep being wired into nothing. `createJobRuntime` is
    // the only place a cron handler is registered; drop one line there and the job still has a
    // name, an endpoint, a pg_cron schedule, a fully tested handler — and a 501 every time it
    // fires. Nothing else in the suite catches that, which is precisely why it is asserted here
    // over the full name list rather than over the two names that happened to work.
    for (const name of CRON_JOB_NAMES) {
      expect(result.output, `${name} is not registered`).toMatch(
        new RegExp(`${name} — registered`, 'u'),
      );
    }
    expect(result.output).not.toContain('NOT REGISTERED');
  });

  it('cron:run:all runs every job and now succeeds overall, all three sweeps being registered', async () => {
    const before = await Promise.all(CRON_JOB_NAMES.map((name) => countJobRuns(handle, name)));
    const result = runNpmScript('cron:run:all');

    // Was non-zero while alert-evaluation had no handler. Zero is the T-034 state, and a
    // regression to non-zero means a sweep lost its handler again.
    expect(result.status).toBe(0);
    const after = await Promise.all(CRON_JOB_NAMES.map((name) => countJobRuns(handle, name)));
    // Each job gains exactly one row: a short-circuit on the first failure would leave later jobs
    // at their previous count and hide their status.
    after.forEach((count, index) => {
      expect(count).toBe((before[index] ?? 0) + 1);
    });
  });
});

async function countJobRuns(handle: DbHandle, jobName: string): Promise<number> {
  const row = await handle.db
    .selectFrom('job_run')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('job_name', '=', jobName)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

async function latestJobRun(
  handle: DbHandle,
  jobName: string,
): Promise<
  | {
      status: string;
      trigger: string;
      error_class: string | null;
      error_message: string | null;
      counts: unknown;
    }
  | undefined
> {
  return handle.db
    .selectFrom('job_run')
    .select(['status', 'trigger', 'error_class', 'error_message', 'counts'])
    .where('job_name', '=', jobName)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
}
