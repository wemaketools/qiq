import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { probeLocalStack, suiteTitle, type StackProbe } from './helpers/local-stack.js';
import { repoRoot } from './helpers/repo.js';

/**
 * `npm run db:cron:configure` — the out-of-band writer for `public.job_cron_config`.
 *
 * The migration that creates that table states the rule this script exists to honour: the origin
 * and the two bearer secrets may not live in a migration or in the committed seed, because the
 * origin differs per environment and the secrets must never enter version control. What is left
 * to test is therefore the script itself: that it writes what it claims, converges on a re-run
 * (so it is safe on every deploy, and so secret rotation is just another run), and REFUSES rather
 * than inventing a value when pointed somewhere it should not be.
 *
 * The refusal cases matter more than the happy path. A wrong row here fails silently — the
 * schedules 401 against their own endpoints hours later, in a log nobody is tailing.
 */

const probe: StackProbe = await probeLocalStack();
const tsxCli = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const BASE_URL = 'https://cron-config-test.example.com';

let tempDir: string | null = null;
let fileSeq = 0;

/**
 * The full server catalog, written to a temp file and handed to the CLI with `--env-file`.
 *
 * Deliberately NOT `spawnSync({ env })`: reading `process.env` is refused repo-wide outside the
 * config module (config-env-access), tests included, and the seeds' own guard tests already drive
 * their CLI this way. Supplying the whole catalog also means a failure proves the script's own
 * guard fired, never that a variable was incidentally missing.
 */
function writeEnvFile(overrides: Readonly<Record<string, string>>, omit: readonly string[]): string {
  if (!probe.available) throw new Error('local stack unavailable');
  const { stack } = probe;

  const values: Record<string, string> = {
    APP_ENV: 'local',
    SUPABASE_DATABASE_URL: stack.dbUrl,
    SUPABASE_DIRECT_DATABASE_URL: stack.dbUrl,
    SUPABASE_URL: stack.apiUrl,
    SUPABASE_ANON_KEY: stack.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
    CRON_SECRET: 'cron-secret-fixture',
    INTERNAL_JOB_SECRET: 'job-secret-fixture',
    API_KEY_PEPPER: 'pepper-fixture-0123',
    JOB_CRON_BASE_URL: BASE_URL,
    ...overrides,
  };
  for (const key of omit) delete values[key];

  tempDir ??= mkdtempSync(join(tmpdir(), 'quoteiq-cron-config-'));
  const path = join(tempDir, `env-${String(fileSeq++)}.env`);
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  writeFileSync(path, `${body}\n`, 'utf8');
  return path;
}

/** `omit` drops a variable entirely, which is how "unset" is distinguished from "empty". */
function run(
  options: {
    overrides?: Readonly<Record<string, string>>;
    omit?: readonly string[];
    args?: readonly string[];
  } = {},
): { status: number | null; output: string } {
  const envFile = writeEnvFile(options.overrides ?? {}, options.omit ?? []);
  const result = spawnSync(
    process.execPath,
    [
      tsxCli,
      `--env-file=${envFile}`,
      'scripts/db/configure-job-cron.ts',
      ...(options.args ?? []),
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, windowsHide: true },
  );
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

async function query<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
  if (!probe.available) throw new Error('local stack unavailable');
  const client = new pg.Client({ connectionString: probe.stack.dbUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

describe(suiteTitle('db:cron:configure', probe), () => {
  // The table is shared infrastructure config, and pg-cron-schedules.test.ts writes it too. Leave
  // the database as found rather than assuming this suite runs last.
  let hadRow = false;

  beforeAll(async () => {
    if (!probe.available) return;
    const rows = await query<{ n: string }>('select count(*)::text as n from public.job_cron_config');
    hadRow = rows[0]?.n !== '0';
  });

  afterAll(async () => {
    if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
    if (!probe.available || hadRow) return;
    await query('delete from public.job_cron_config');
  });

  it.runIf(probe.available)('resolves the tsx entrypoint this suite drives', () => {
    expect(existsSync(tsxCli)).toBe(true);
  });

  it.runIf(probe.available)('writes the origin and both bearer secrets', async () => {
    const result = run();
    expect(result.status, `expected success, got:\n${result.output}`).toBe(0);
    expect(result.output).toContain('OK: cron schedule configuration applied');

    const rows = await query<{ base_url: string; has_cron: boolean; has_internal: boolean }>(
      `select base_url,
              cron_secret is not null         as has_cron,
              internal_job_secret is not null as has_internal
         from public.job_cron_config`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.base_url).toBe(BASE_URL);
    expect(rows[0]?.has_cron).toBe(true);
    expect(rows[0]?.has_internal).toBe(true);
  });

  it.runIf(probe.available)('never prints either secret', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.output).not.toContain('cron-secret-fixture');
    expect(result.output).not.toContain('job-secret-fixture');
  });

  it.runIf(probe.available)('converges: a re-run leaves exactly one row, not a duplicate', async () => {
    expect(run().status).toBe(0);
    expect(run().status).toBe(0);

    const rows = await query<{ n: string }>('select count(*)::text as n from public.job_cron_config');
    expect(rows[0]?.n).toBe('1');
  });

  it.runIf(probe.available)('rotates: a changed secret overwrites the previous one', async () => {
    expect(run().status).toBe(0);
    const before = await query<{ secret: string }>(
      'select cron_secret as secret from public.job_cron_config',
    );

    expect(run({ overrides: { CRON_SECRET: 'cron-secret-rotated' } }).status).toBe(0);

    const after = await query<{ secret: string }>(
      'select cron_secret as secret from public.job_cron_config',
    );
    expect(after[0]?.secret).not.toBe(before[0]?.secret);
    expect(after[0]?.secret).toBe('cron-secret-rotated');
  });

  it.runIf(probe.available)(
    'refuses, rather than inventing an origin, when JOB_CRON_BASE_URL is unset',
    () => {
      const result = run({ omit: ['JOB_CRON_BASE_URL'] });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('JOB_CRON_BASE_URL is not set');
    },
  );

  it.runIf(probe.available)('rejects a trailing slash, which would double the slash in the path', () => {
    const result = run({ overrides: { JOB_CRON_BASE_URL: `${BASE_URL}/` } });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('trailing slash');
  });

  it.runIf(probe.available)('rejects a base URL carrying a path, which would 404 the endpoint', () => {
    const result = run({ overrides: { JOB_CRON_BASE_URL: `${BASE_URL}/api` } });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('origin only');
  });

  it.runIf(probe.available)('refuses a non-local target that is not explicitly named', () => {
    const result = run({ overrides: { APP_ENV: 'production' } });
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/refus/i);
    expect(result.output).toContain('--env=production');
  });

  it.runIf(probe.available)('refuses when the named environment disagrees with the loaded one', () => {
    const result = run({ overrides: { APP_ENV: 'dev' }, args: ['--env=production'] });
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/refus/i);
  });

  it.runIf(probe.available)('accepts a non-local target once it is named', async () => {
    const result = run({ overrides: { APP_ENV: 'dev' }, args: ['--env=dev'] });
    expect(result.status, `expected success, got:\n${result.output}`).toBe(0);
    expect(result.output).toContain('target environment: dev');

    const rows = await query<{ n: string }>('select count(*)::text as n from public.job_cron_config');
    expect(rows[0]?.n).toBe('1');
  });

  it.runIf(probe.available)('rejects an unknown argument instead of silently ignoring it', () => {
    const result = run({ args: ['--force'] });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('Unknown argument');
  });
});
