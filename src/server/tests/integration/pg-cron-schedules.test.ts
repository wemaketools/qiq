/**
 * The pg_cron schedules registered by migration (T-032; AC-068; V-085).
 *
 * V-085 is shared between T-032 (the two expiry schedules) and T-034 (alert-evaluation and the
 * every-minute queue drain). All four are asserted here.
 *
 * WHY THIS SUITE NOW *EXECUTES* THE HELPERS (T-034)
 * ================================================
 * It previously asserted the `cron.job` rows and the helper's SOURCE TEXT. Both passed while
 * `invoke_cron_endpoint` called `extensions.http_get`, a function that DOES NOT EXIST — pg_net
 * registers its extension in `extensions` but installs its functions in the `net` schema. Every
 * deployed sweep would have raised "function extensions.http_get(...) does not exist" at its
 * scheduled minute, forever, and nothing here would have gone red: a schedule that fires into a
 * function that cannot resolve is indistinguishable, from the catalog, from one that works.
 *
 * So the helpers are now CALLED, inside a transaction that inserts a throwaway config row pointing
 * at a black-hole origin and then rolls it back. pg_net queues its request asynchronously and the
 * rollback discards both the config row and the queued request, so this leaves no residue and sends
 * no traffic — but it does force PL/pgSQL to resolve every function the body names.
 *
 * WHY THE COMMAND TEXT IS ASSERTED AND NOT JUST THE NAME
 * =====================================================
 * A `cron.job` row with the right name and a command pointing at the wrong path is exactly as broken
 * as no row at all, and far harder to notice: the schedule fires on time, forever, into a 404. The
 * name, the schedule expression and the invoked path are three separate contracts and all three are
 * checked here.
 *
 * PARTIAL PRE-CUTOVER, per V-085: only REGISTRATION is verifiable locally. pg_net cannot reach a dev
 * server on the host from inside the Supabase container (Q-7), so actual firing against deployed
 * endpoints is post-cutover manual QA. Local behavioural equivalence is covered by the `cron:run`
 * scripts (V-082) and by the two sweep suites.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CRON_JOB_NAMES } from '../../jobs/cron/registry.js';
import { createDb, type DbHandle } from '../../lib/db/index.js';
import { probeLocalStack, suiteTitle } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('pg_cron schedules', probe);

interface CronJobRow {
  readonly jobname: string;
  readonly schedule: string;
  readonly command: string;
  readonly active: boolean;
}

describeStack(title, () => {
  let handle: DbHandle;
  let jobs: Map<string, CronJobRow>;

  beforeAll(async () => {
    if (!probe.available) return;
    handle = createDb({ connectionString: probe.stack.dbUrl });

    const result = await sql<CronJobRow>`
      select jobname, schedule, command, active from cron.job
    `.execute(handle.db);
    jobs = new Map(result.rows.map((row) => [row.jobname, row]));
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
  });

  it.each([
    ['quote-expiry', '0 * * * *'],
    ['lead-inactivity-expiry', '10 * * * *'],
    ['alert-evaluation', '*/15 * * * *'],
  ])('registers %s on the schedule %s, invoking its own endpoint path', (jobName, schedule) => {
    const row = jobs.get(jobName);
    expect(row).toBeDefined();
    expect(row?.schedule).toBe(schedule);
    expect(row?.active).toBe(true);
    // The command must name THIS job — a copy-paste that left the other job's name here would
    // schedule one sweep twice and the other never.
    expect(row?.command).toContain(`invoke_cron_endpoint('${jobName}')`);
  });

  it('registers the queue drain every minute, invoking its own helper', () => {
    // The drain is NOT an /api/cron/{name} endpoint and does not go through `invoke_cron_endpoint`:
    // different path, different secret, different verb. Asserting the helper name here is what
    // stops it being "fixed" into the cron helper, which would send the wrong bearer token and 401
    // every minute in silence.
    const row = jobs.get('queue-drain');
    expect(row).toBeDefined();
    expect(row?.schedule).toBe('* * * * *');
    expect(row?.active).toBe(true);
    expect(row?.command).toContain('invoke_queue_drain()');
  });

  it('exposes exactly one schedule per job name (a duplicate would double-invoke every sweep)', async () => {
    const result = await sql<{ jobname: string; count: string }>`
      select jobname, count(*)::text as count from cron.job
       where jobname in ('quote-expiry', 'lead-inactivity-expiry', 'alert-evaluation', 'queue-drain')
       group by jobname
       order by jobname
    `.execute(handle.db);

    expect(result.rows.map((row) => row.count)).toEqual(['1', '1', '1', '1']);
  });

  it('schedules every cron job name the application knows about (no sweep without a schedule)', () => {
    // The registry is the list of jobs that EXIST; `cron.job` is the list that will ever RUN. A
    // name added to one and not the other is a sweep that is fully implemented, fully tested, and
    // never invoked.
    for (const name of CRON_JOB_NAMES) {
      expect(jobs.has(name), `${name} has no pg_cron schedule`).toBe(true);
    }
  });

  it('resolves each scheduled command to the right URL path through the helper', async () => {
    // The command text is only half the contract; the function it calls has to build the path the
    // endpoint actually serves. Asserting the helper's own source keeps a rename of `api/cron/*`
    // from silently leaving the schedules pointing at a path nobody serves.
    const result = await sql<{ src: string }>`
      select prosrc as src from pg_proc where proname = 'invoke_cron_endpoint'
    `.execute(handle.db);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.src).toContain("'/api/cron/' || job_name");
    // The secret travels as a bearer header, matching what the endpoints authenticate against.
    expect(result.rows[0]?.src).toContain("'Bearer ' || config.cron_secret");
  });

  it.each([
    ['invoke_cron_endpoint', "select public.invoke_cron_endpoint('alert-evaluation')"],
    ['queue drain', 'select public.invoke_queue_drain()'],
  ])(
    '%s RESOLVES AND EXECUTES against a configured row (the assertion source text alone cannot make)',
    async (_label, statement) => {
      // Everything happens inside one transaction that is always rolled back, so the config row —
      // and pg_net's queued request row — never survive this test.
      await sql`begin`.execute(handle.db);
      try {
        await sql`
          insert into public.job_cron_config (base_url, cron_secret, internal_job_secret)
          values ('http://127.0.0.1:9', 'probe-not-a-real-secret', 'probe-not-a-real-secret')
        `.execute(handle.db);

        // The bug this catches raises 'function extensions.http_get(...) does not exist' HERE.
        await expect(sql.raw(statement).execute(handle.db)).resolves.toBeDefined();
      } finally {
        await sql`rollback`.execute(handle.db);
      }

      // Residue check: the throwaway credentials must be gone.
      const after = await sql<{ count: string }>`
        select count(*)::text as count from public.job_cron_config
      `.execute(handle.db);
      expect(after.rows[0]?.count).toBe('0');
    },
  );

  it('the drain helper no-ops rather than erroring when only the cron half is configured', async () => {
    // An operator who populated the T-032 row before this column existed leaves
    // internal_job_secret null. That must be a NOTICE and a skip, not a failure every 60 seconds.
    await sql`begin`.execute(handle.db);
    try {
      await sql`
        insert into public.job_cron_config (base_url, cron_secret)
        values ('http://127.0.0.1:9', 'probe-not-a-real-secret')
      `.execute(handle.db);
      await expect(sql`select public.invoke_queue_drain()`.execute(handle.db)).resolves.toBeDefined();
    } finally {
      await sql`rollback`.execute(handle.db);
    }
  });

  it('commits no URL and no secret: the config table exists but is empty locally', async () => {
    const result = await sql<{ count: string }>`
      select count(*)::text as count from public.job_cron_config
    `.execute(handle.db);

    // If a migration or the committed seed ever populates this, a real origin and a real bearer
    // secret are in version control. Zero rows locally is the assertion that they are not.
    expect(result.rows[0]?.count).toBe('0');
  });

  it('does not expose the secret-bearing config table to the API roles', async () => {
    const result = await sql<{ grantee: string; privilege_type: string }>`
      select grantee, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'job_cron_config'
         and grantee in ('anon', 'authenticated')
    `.execute(handle.db);

    expect(result.rows).toEqual([]);
  });
});
