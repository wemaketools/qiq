#!/usr/bin/env tsx
/**
 * Writes the single `public.job_cron_config` row the pg_cron -> pg_net schedules read (T-032).
 *
 * This is the `npm run db:cron:configure` named by 20260720000000_pg_cron_expiry_schedules.sql,
 * which states the rule this script exists to honour:
 *
 *     NO URL AND NO SECRET IS COMMITTED HERE [...] the origin differs per environment and the
 *     secret must never enter version control.
 *
 * So the values are NOT in a migration and NOT in the committed seed: they come from the loaded
 * configuration, which in a deployed environment comes from the secret store. Running this as a
 * deploy step is what keeps `job_cron_config` in step with CRON_SECRET / INTERNAL_JOB_SECRET
 * without either ever being written to a file in this repository.
 *
 * Usage:
 *   npm run db:cron:configure                 configure the configured (local) database
 *   npm run db:cron:configure -- --env=dev    required for anything that is not local
 *
 * SAFETY: identical gate to the seeds — the target comes from the loaded configuration, and a
 * non-local target additionally requires the operator to NAME it. The decision function is shared
 * with the seeds rather than reimplemented, because a second copy of a safety-critical branch is
 * a second thing to get wrong. See scripts/db/seed-target.ts.
 *
 * CONNECTION: SUPABASE_DIRECT_DATABASE_URL, never the pooler (A-8).
 *
 * IDEMPOTENCY: one row, upserted. Re-running converges, which is what makes it safe to run on
 * every deploy and what makes secret rotation a matter of re-running it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: schedule anything. The schedules themselves are created by
 * migrations; this only supplies the origin and bearer secrets they call with. An empty table
 * leaves them as no-ops that say so in the Postgres log.
 */
import pg from 'pg';

import { getConfig, ConfigurationError, type AppConfig } from '../../src/server/lib/config/index.js';
import { decideSeedTarget } from './seed-target.js';

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`\nCRON CONFIGURATION FAILED\n${message}\n`);
  process.exit(1);
}

/** `--env=dev` -> "dev"; `--env dev` -> "dev"; absent -> null. */
export function parseEnvFlag(argv: readonly string[]): string | null {
  const inline = argv.find((arg) => arg.startsWith('--env='));
  if (inline !== undefined) return inline.slice('--env='.length);

  const index = argv.indexOf('--env');
  if (index === -1) return null;
  return argv[index + 1] ?? '';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const unknown: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg.startsWith('--env=')) continue;
    if (arg === '--env') {
      index += 1; // its value
      continue;
    }
    unknown.push(arg);
  }
  if (unknown.length > 0) {
    fail(
      `Unknown argument(s): ${unknown.join(', ')}\n` +
        'Usage: npm run db:cron:configure -- [--env=<environment>]',
    );
  }

  let config: AppConfig;
  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      fail(
        `${error.message}\n\nConfiguring the cron schedules needs SUPABASE_DIRECT_DATABASE_URL, ` +
          'CRON_SECRET, INTERNAL_JOB_SECRET and JOB_CRON_BASE_URL.',
      );
    }
    throw error;
  }

  const decision = decideSeedTarget(config.appEnv, parseEnvFlag(argv));
  if (!decision.allowed) {
    // A refusal, not a crash. Non-zero so no pipeline mistakes it for a completed configuration.
    process.stderr.write(`\n${decision.reason}\n`);
    process.exit(1);
  }

  const baseUrl = config.jobs.cronBaseUrl;
  if (baseUrl === null) {
    fail(
      'JOB_CRON_BASE_URL is not set, and there is no sensible default: the schedules must call a\n' +
        'DEPLOYED origin, which differs per environment.\n\n' +
        'Set it to the STABLE origin for this environment — a preview URL that changes per\n' +
        'deployment will break the schedules on the next deploy. Origin only, no trailing slash:\n' +
        '  JOB_CRON_BASE_URL=https://quoteiq.example.com',
    );
  }

  log('Cron schedule configuration (public.job_cron_config)');
  log(`  target environment: ${decision.appEnv}`);
  log(`  base_url          : ${baseUrl}`);
  log('  connection        : SUPABASE_DIRECT_DATABASE_URL (direct, not the pooler)');

  // The secrets are never logged: this row exists precisely because they must not be written down.
  const client = new pg.Client({ connectionString: config.database.directUrl });
  await client.connect();

  try {
    await client.query(
      `insert into public.job_cron_config (id, base_url, cron_secret, internal_job_secret)
            values (true, $1, $2, $3)
       on conflict (id) do update
               set base_url            = excluded.base_url,
                   cron_secret         = excluded.cron_secret,
                   internal_job_secret = excluded.internal_job_secret,
                   updated_at          = now()`,
      [baseUrl, config.secrets.cronSecret, config.secrets.internalJobSecret],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Writing public.job_cron_config failed.\n${message}`);
  } finally {
    await client.end();
  }

  const applied = await verify(config.database.directUrl, baseUrl);
  if (!applied.ok) {
    fail(`The row did not read back as written.\n  - ${applied.problems.join('\n  - ')}`);
  }

  log(`  rows              : ${applied.rows} (the CHECK constraint permits exactly one)`);
  log('OK: cron schedule configuration applied (re-runnable; re-running converges).');
}

/**
 * Reads the row back rather than trusting the write. A silently-wrong row here does not fail
 * anything at write time — it surfaces as schedules that 401 against their own endpoints, hours
 * later, in a log nobody is tailing.
 */
async function verify(
  connectionString: string,
  expectedBaseUrl: string,
): Promise<{ ok: boolean; rows: number; problems: string[] }> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{
      rows: string;
      base_url: string | null;
      has_cron_secret: boolean | null;
      has_internal_job_secret: boolean | null;
    }>(
      `select (select count(*) from public.job_cron_config)::text as rows,
              base_url,
              cron_secret is not null         as has_cron_secret,
              internal_job_secret is not null as has_internal_job_secret
         from public.job_cron_config`,
    );

    const row = result.rows[0];
    const problems: string[] = [];
    if (row === undefined) problems.push('no row was found after the upsert');
    else {
      if (row.base_url !== expectedBaseUrl) {
        problems.push(`base_url reads back as "${row.base_url ?? 'null'}"`);
      }
      if (row.has_cron_secret !== true) problems.push('cron_secret is null');
      if (row.has_internal_job_secret !== true) problems.push('internal_job_secret is null');
    }

    return { ok: problems.length === 0, rows: Number(row?.rows ?? 0), problems };
  } finally {
    await client.end();
  }
}

await main();
