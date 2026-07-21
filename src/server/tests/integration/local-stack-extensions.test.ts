/**
 * AC-003 / V-004: the local Supabase database must expose pg_cron, pgmq and pg_net after
 * migrations, and they must actually work — not merely appear in pg_available_extensions.
 * Every job-platform task from T-031 onward assumes this.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('local Supabase database extensions', probe);

describeStack(title, () => {
  let client: Client;
  let stack: LocalStack;

  beforeAll(async () => {
    if (!probe.available) return;
    stack = probe.stack;
    client = new Client({ connectionString: stack.dbUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it('installs pg_cron, pgmq and pg_net after migrations are applied', async () => {
    const { rows } = await client.query<{ extname: string; schema: string }>(
      `select e.extname, n.nspname as schema
         from pg_extension e
         join pg_namespace n on n.oid = e.extnamespace
        where e.extname = any($1::text[])
        order by e.extname`,
      [['pg_cron', 'pg_net', 'pgmq']],
    );

    expect(rows.map((r) => r.extname)).toEqual(['pg_cron', 'pg_net', 'pgmq']);
  });

  it('allows pg_cron to schedule and unschedule a job', async () => {
    const jobName = `quoteiq_probe_${process.pid}`;
    // Clean up a leftover from a crashed previous run so the test is re-runnable.
    await client.query('select cron.unschedule(jobid) from cron.job where jobname = $1', [jobName]);

    // cron.schedule returns a bigint job id, which the pg driver surfaces as a string.
    const scheduled = await client.query<{ schedule: string }>(
      "select cron.schedule($1, '0 0 1 1 *', 'select 1') as schedule",
      [jobName],
    );
    expect(Number(scheduled.rows[0]?.schedule)).toBeGreaterThan(0);

    const listed = await client.query('select 1 from cron.job where jobname = $1', [jobName]);
    expect(listed.rowCount).toBe(1);

    const unscheduled = await client.query<{ unschedule: boolean }>(
      'select cron.unschedule($1) as unschedule',
      [jobName],
    );
    expect(unscheduled.rows[0]?.unschedule).toBe(true);
  });

  it('allows pgmq to create a queue and round-trip a message', async () => {
    const queueName = `quoteiq_probe_${process.pid}`;
    await client.query('select pgmq.drop_queue($1) where exists (select 1 from pgmq.list_queues() q where q.queue_name = $1)', [queueName]);
    await client.query('select pgmq.create($1)', [queueName]);

    try {
      const sent = await client.query<{ send: string }>("select pgmq.send($1, '{\"probe\":true}'::jsonb) as send", [
        queueName,
      ]);
      expect(sent.rows[0]?.send).toBeDefined();

      const read = await client.query<{ msg_id: string; message: { probe: boolean } }>(
        'select msg_id, message from pgmq.read($1, 5, 1)',
        [queueName],
      );
      expect(read.rows[0]?.message).toEqual({ probe: true });

      const deleted = await client.query<{ delete: boolean }>('select pgmq.delete($1, $2::bigint) as delete', [
        queueName,
        read.rows[0]!.msg_id,
      ]);
      expect(deleted.rows[0]?.delete).toBe(true);
    } finally {
      await client.query('select pgmq.drop_queue($1)', [queueName]);
    }
  });

  it('allows pg_net to enqueue an outbound HTTP request', async () => {
    // Resolve the schema pg_net landed in rather than assuming, then call it there.
    const { rows: schemaRows } = await client.query<{ schema: string }>(
      `select n.nspname as schema
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_depend d on d.objid = p.oid and d.deptype = 'e'
         join pg_extension e on e.oid = d.refobjid
        where e.extname = 'pg_net' and p.proname = 'http_get'
        limit 1`,
    );
    const schema = schemaRows[0]?.schema;
    expect(schema, 'pg_net http_get function not found').toBeDefined();
    // Identifier interpolation: constrain to a plain identifier before embedding it.
    expect(schema).toMatch(/^[a-z_][a-z0-9_]*$/);

    // http_get returns the id of a durably queued request; the worker performs it
    // asynchronously. Getting an id back is the usability proof — we deliberately do not
    // assert on the response, which would make the test dependent on network timing.
    const { rows } = await client.query<{ request_id: string }>(
      `select "${schema}".http_get($1) as request_id`,
      [`${stack.apiUrl}/auth/v1/health`],
    );
    expect(Number(rows[0]?.request_id)).toBeGreaterThan(0);
  });
});
