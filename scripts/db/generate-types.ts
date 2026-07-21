#!/usr/bin/env tsx
/**
 * `npm run db:types` — regenerate the TypeScript database types from the LOCAL Supabase schema
 * (T-008, M-12, AC-013).
 *
 * CODEGEN TOOL DECISION: `supabase gen types typescript --local`.
 * -------------------------------------------------------------
 * M-12 permits either the Supabase CLI or `kysely-codegen`. The CLI wins because it is already a
 * pinned devDependency in the approved set, whereas kysely-codegen would be a new, unapproved
 * dependency. Its output does NOT declare Kysely table interfaces directly, but it emits a
 * `{ Row, Insert, Update }` triple per table, which is exactly the shape of Kysely's
 * `ColumnType<Select, Insert, Update>`. The mapping is a purely type-level adapter in
 * `src/server/lib/db/kyselify.ts` — no runtime cost and no information loss.
 *
 * Three artifacts are produced, ALL generated from the live database so none can silently drift:
 *
 *   1. generated/supabase-types.ts  — verbatim CLI output.
 *   2. generated/column-overrides.ts — the columns whose RUNTIME JavaScript type differs from what
 *      the CLI claims. The CLI maps every numeric-ish Postgres type to `number`, but node-postgres
 *      returns `numeric` as a STRING (deliberately: `numeric` is arbitrary-precision and money must
 *      not round-trip through an IEEE-754 double). Rather than hand-maintaining that list, it is
 *      queried from information_schema, so a new numeric column added by a future migration is
 *      picked up automatically the next time this script runs.
 *   3. generated/tenant-scoped-tables.ts — the tables carrying a `tenant_id` column, so that
 *      `forTenant` covers a newly added tenant-scoped table without anyone remembering to list it.
 *      tenant.ts type-checks this list against artifact 1, so the two cannot drift apart.
 *
 * `bigint` needs no override: the pool in src/server/lib/db/pool.ts installs an int8 parser that
 * returns a JS number (and throws above Number.MAX_SAFE_INTEGER rather than losing precision), so
 * runtime matches the CLI's `number` exactly. See pool.ts for that rationale.
 *
 * Usage:
 *   npm run db:types              regenerate and write the files
 *   npm run db:types -- --check   fail (exit 1) if the committed files are stale (CI drift gate)
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import pg from 'pg';

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * `--out <dir>` redirects generation away from the committed files (F-008-7).
 *
 * The write-mode case in db-types-drift.test.ts used to regenerate the REAL generated files and
 * restore them from an in-memory snapshot in a `finally`. That left two windows in which the
 * committed artifacts are corrupted: an interrupted run never reaches the restore, and two
 * concurrent runs interleave — B snapshots while A's regenerated content is on disk, so B's
 * "restore" writes A's content back permanently. The second happened for real during three
 * parallel implementor tasks and surfaced later as unrelated typecheck failures, because T-008's
 * compile-time guard reads these files. A test that needs to prove generation works can now write
 * to a temp directory instead of the tree everything else depends on.
 */
function outDirArg(): string | null {
  const i = process.argv.indexOf('--out');
  if (i === -1) return null;
  const value = process.argv[i + 1];
  if (!value) {
    process.stderr.write('\nDB TYPE GENERATION FAILED\n--out requires a directory path\n');
    process.exit(1);
  }
  return resolve(value);
}

const generatedDir = outDirArg() ?? resolve(repoRoot, 'src', 'server', 'lib', 'db', 'generated');
const supabaseTypesPath = resolve(generatedDir, 'supabase-types.ts');
const overridesPath = resolve(generatedDir, 'column-overrides.ts');
const tenantTablesPath = resolve(generatedDir, 'tenant-scoped-tables.ts');

// Invoke the pinned CLI through its JS entrypoint with the current node binary: Node 22+ on
// Windows refuses to spawn `npx.cmd` without a shell (EINVAL). Same approach as
// scripts/db/validate-migrations.ts and the local-stack test helper.
const supabaseCli = createRequire(import.meta.url).resolve('supabase/dist/supabase.js');

const checkOnly = process.argv.includes('--check');

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`\nDB TYPE GENERATION FAILED\n${message}\n`);
  process.exit(1);
}

const BANNER = [
  '// GENERATED FILE — DO NOT EDIT BY HAND.',
  '// Regenerate with `npm run db:types` (scripts/db/generate-types.ts).',
  '// CI runs `npm run db:types -- --check`, which fails if this file is stale (AC-013).',
  '',
].join('\n');

async function runCli(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [supabaseCli, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return fail(
      [
        `\`supabase ${args.join(' ')}\` failed.`,
        'Is the local stack running? Start Docker Desktop and run `npm run supabase:start`.',
        err.stderr?.trim() ?? err.message ?? '',
      ].join('\n'),
    );
  }
}

/** Reads the local stack's direct database URL; avoids depending on a populated .env.local. */
async function localDatabaseUrl(): Promise<string> {
  const stdout = await runCli(['status', '-o', 'json']);
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) fail(`Could not find JSON in \`supabase status\` output:\n${stdout}`);
  const parsed = JSON.parse(stdout.slice(jsonStart)) as { DB_URL?: string };
  if (!parsed.DB_URL) fail('`supabase status` did not report DB_URL.');
  return parsed.DB_URL;
}

/**
 * The CLI prints progress lines ("Connecting to db 5432") before the payload on some versions.
 * Everything before the first `export` is preamble, not TypeScript.
 */
function stripPreamble(stdout: string): string {
  const start = stdout.indexOf('export type Json');
  if (start === -1) {
    fail(`\`supabase gen types\` produced no recognisable output:\n${stdout.slice(0, 500)}`);
  }
  return stdout.slice(start).replace(/\r\n/g, '\n').trimEnd();
}

interface NumericColumnRow {
  readonly table_name: string;
  readonly column_name: string;
}

/**
 * Columns typed `numeric` in Postgres. node-postgres returns these as strings; the Supabase CLI
 * declares them `number`. The type adapter uses this list to correct the declaration.
 *
 * Partitions are excluded here for the same reason `kyselify.ts` drops them: rows are always read
 * and written through the partitioned parent.
 */
const NUMERIC_COLUMNS_SQL = `
  select c.table_name, c.column_name
    from information_schema.columns c
    join pg_class rel on rel.relname = c.table_name
    join pg_namespace ns on ns.oid = rel.relnamespace and ns.nspname = c.table_schema
   where c.table_schema = 'public'
     and c.data_type = 'numeric'
     and rel.relispartition = false
   order by c.table_name, c.column_name
`;

async function readNumericColumns(databaseUrl: string): Promise<NumericColumnRow[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<NumericColumnRow>(NUMERIC_COLUMNS_SQL);
    return result.rows;
  } finally {
    await client.end();
  }
}

function renderOverrides(rows: readonly NumericColumnRow[]): string {
  const byTable = new Map<string, string[]>();
  for (const row of rows) {
    const columns = byTable.get(row.table_name) ?? [];
    columns.push(row.column_name);
    byTable.set(row.table_name, columns);
  }

  const entries = [...byTable.entries()].map(([table, columns]) => {
    const union = columns.map((column) => `'${column}'`).join(' | ');
    return `  readonly ${table}: ${union};`;
  });

  return [
    BANNER,
    '/**',
    ' * Columns whose runtime JavaScript type differs from the Supabase CLI declaration.',
    ' *',
    ' * Every column listed here is Postgres `numeric`. node-postgres returns `numeric` as a STRING',
    ' * because it is arbitrary-precision — parsing premiums into IEEE-754 doubles would silently',
    ' * corrupt money. The CLI declares them `number`, so kyselify.ts rewrites them to `string`.',
    ' *',
    ' * Generated from information_schema, so a numeric column added by a later migration is picked',
    ' * up automatically by `npm run db:types`.',
    ' */',
    entries.length === 0
      ? 'export interface NumericColumns {\n  readonly [table: string]: never;\n}'
      : `export interface NumericColumns {\n${entries.join('\n')}\n}`,
    '',
  ].join('\n');
}

/**
 * Tables carrying a `tenant_id` column. Generated rather than hand-listed so that a tenant-scoped
 * table added by a future migration is protected by `forTenant` automatically — a table missing
 * from this list is a table nothing scopes. Partitions are excluded: writes go through the parent.
 */
const TENANT_TABLES_SQL = `
  select distinct c.table_name
    from information_schema.columns c
    join pg_class rel on rel.relname = c.table_name
    join pg_namespace ns on ns.oid = rel.relnamespace and ns.nspname = c.table_schema
   where c.table_schema = 'public'
     and c.column_name = 'tenant_id'
     and rel.relispartition = false
     and rel.relkind in ('r', 'p')
   order by c.table_name
`;

async function readTenantScopedTables(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ table_name: string }>(TENANT_TABLES_SQL);
    return result.rows.map((row) => row.table_name);
  } finally {
    await client.end();
  }
}

function renderTenantTables(tables: readonly string[]): string {
  return [
    BANNER,
    '/**',
    ' * Every `public` table with a `tenant_id` column, from information_schema.',
    ' *',
    ' * src/server/lib/db/tenant.ts type-checks this list against the generated Kysely schema, so',
    ' * the two generated artifacts cannot drift apart without failing the build.',
    ' */',
    'export const TENANT_SCOPED_TABLE_NAMES = [',
    ...tables.map((table) => `  '${table}',`),
    '] as const;',
    '',
  ].join('\n');
}

function writeOrCheck(path: string, contents: string, stale: string[]): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : null;
  if (existing === contents) return;
  if (checkOnly) {
    stale.push(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  log(`  wrote ${path.slice(repoRoot.length + 1)}`);
}

/**
 * Partition tables in `public`, which must NOT reach the generated schema.
 *
 * `supabase gen types` emits every table it finds, including partitions. Partitions are created at
 * runtime by `create_tenant_partitions` whenever a tenant is created — so any test that creates a
 * tenant changes the CLI's output, and regenerating afterwards bakes `leads_p44`-style tables into
 * the committed schema. That both breaks T-008's `everySchemaTableIsListed` guard (partitions carry
 * `tenant_id` but are not in the tenant-scoped list) and makes `--check` report phantom drift whose
 * cause is invisible in the failure message. Writes go through the partitioned parent anyway, so
 * partitions have no business in the type surface.
 */
const PARTITION_TABLES_SQL = `
  select rel.relname as table_name
    from pg_class rel
    join pg_namespace ns on ns.oid = rel.relnamespace
   where ns.nspname = 'public'
     and rel.relispartition = true
   order by rel.relname
`;

async function readPartitionTables(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ table_name: string }>(PARTITION_TABLES_SQL);
    return result.rows.map((row) => row.table_name);
  } finally {
    await client.end();
  }
}

/** Removes each partition's `name: { Row: ... }` block from the CLI's emitted Tables section. */
function stripPartitions(source: string, partitions: readonly string[]): string {
  let output = source;
  for (const name of partitions) {
    // Match the table entry at its own indentation through to the line that closes it, which the
    // CLI always emits at the same indentation as the opening key.
    const pattern = new RegExp(String.raw`\n(\s+)${name}: \{\n[\s\S]*?\n\1\}`, 'g');
    output = output.replace(pattern, '');
  }
  return output;
}

async function main(): Promise<void> {
  log(checkOnly ? 'Checking generated DB types for drift...' : 'Generating DB types...');

  const databaseUrl = await localDatabaseUrl();
  const genStdout = await runCli(['gen', 'types', 'typescript', '--local']);
  const partitions = await readPartitionTables(databaseUrl);
  const supabaseTypes = `${BANNER}${stripPartitions(stripPreamble(genStdout), partitions)}\n`;
  const overrides = renderOverrides(await readNumericColumns(databaseUrl));
  const tenantTables = renderTenantTables(await readTenantScopedTables(databaseUrl));

  const stale: string[] = [];
  writeOrCheck(supabaseTypesPath, supabaseTypes, stale);
  writeOrCheck(overridesPath, overrides, stale);
  writeOrCheck(tenantTablesPath, tenantTables, stale);

  if (stale.length > 0) {
    fail(
      [
        'The committed database types do not match the local schema:',
        ...stale.map((path) => `  - ${path.slice(repoRoot.length + 1)}`),
        '',
        'Run `npm run db:types` and commit the result.',
      ].join('\n'),
    );
  }

  log(checkOnly ? 'Generated DB types are up to date.' : 'Done.');
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
