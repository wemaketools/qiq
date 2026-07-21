#!/usr/bin/env tsx
/**
 * Migration-from-clean validation (T-005, AC-086, V-110). Used by CI in T-010.
 *
 * Answers three questions that `supabase db reset` alone does not:
 *
 *   1. DOES THE FULL MIGRATION SET APPLY FROM AN EMPTY DATABASE, WITH ZERO ERRORS?
 *      The CLI's exit code is necessary but not sufficient — it has historically exited 0 while
 *      printing per-statement failures — so the output is ALSO scanned for error markers and the
 *      applied-migration list is checked against the files on disk. A migration that is silently
 *      skipped is exactly the kind of failure a green exit code hides.
 *
 *   2. IS THE RESET PATH REPEATABLE? The reset runs TWICE. A migration that only works against a
 *      database that already contains its own objects (a bare CREATE that should be CREATE OR
 *      REPLACE, an ALTER assuming a prior column) passes once and fails on the second run.
 *
 *   3. HAS THE SCHEMA DRIFTED FROM WHAT IS CHECKED IN? The resulting schema is dumped and diffed
 *      against supabase/schema.expected.sql. Migrations are append-only, so an EDIT to an existing
 *      migration file changes the schema a fresh database gets while leaving every already-migrated
 *      environment untouched — a divergence nothing else in the test suite would notice.
 *
 * Usage:
 *   npm run db:validate            fail if the dump differs from the checked-in snapshot
 *   npm run db:validate -- --update-snapshot   rewrite the snapshot (review the diff before commit)
 *
 * SCRATCH DATABASE NOTE: "scratch" here is the local Supabase database, recreated from empty by
 * `supabase db reset`. It is deliberately NOT a side database created with CREATE DATABASE: the
 * extensions migration installs pg_cron, which Postgres only permits in the one database named by
 * the cron.database_name server setting, so a side database could not run the real migration set.
 * THIS SCRIPT IS THEREFORE DESTRUCTIVE TO LOCAL DATA — it is a validation tool, not a dev-loop tool.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDir = resolve(repoRoot, 'supabase', 'migrations');
const snapshotPath = resolve(repoRoot, 'supabase', 'schema.expected.sql');
const dumpPath = resolve(repoRoot, 'supabase', '.schema.actual.sql');

// Invoke the pinned CLI through its JS entrypoint with the current node binary: Node 22+ on
// Windows refuses to spawn `npx.cmd` without a shell (EINVAL). Same approach as the local-stack
// test helper and ensure-signing-keys.mjs.
const supabaseCli = createRequire(import.meta.url).resolve('supabase/dist/supabase.js');

const updateSnapshot = process.argv.includes('--update-snapshot');

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`\nMIGRATION VALIDATION FAILED\n${message}\n`);
  process.exit(1);
}

interface RunResult {
  stdout: string;
  stderr: string;
}

async function runCli(args: readonly string[], label: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [supabaseCli, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      // A full reset applies every migration and restarts containers.
      timeout: 10 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    fail(
      `${label} exited non-zero.\n` +
        `stdout:\n${err.stdout ?? '(none)'}\n` +
        `stderr:\n${err.stderr ?? err.message ?? '(none)'}`,
    );
  }
}

/**
 * Scans reset output for failure markers the CLI may print without failing the process.
 *
 * NOTICE lines are expected and benign (`schema "extensions" already exists, skipping`), so the
 * match is deliberately anchored to error-severity prefixes rather than any occurrence of the
 * substring "error" — which would match a migration filename or a column called `error_message`.
 */
function assertNoErrors(output: string, label: string): void {
  const offending = output
    .split(/\r?\n/)
    .filter((line) => /^\s*(ERROR|FATAL|PANIC)\b/i.test(line) || /\b(ERROR|FATAL):\s/.test(line));
  if (offending.length > 0) {
    fail(`${label} reported ${offending.length} error line(s):\n${offending.join('\n')}`);
  }
}

/** Every migration file on disk must appear in the reset output as actually applied. */
function assertAllMigrationsApplied(output: string): void {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  if (files.length === 0) fail(`No migrations found in ${migrationsDir}`);

  const missing = files.filter((file) => !output.includes(`Applying migration ${file}`));
  if (missing.length > 0) {
    fail(
      `The reset did not apply ${missing.length} migration file(s) present on disk:\n` +
        missing.map((m) => `  - ${m}`).join('\n') +
        '\nA migration that is never applied leaves a fresh database missing objects the code assumes.',
    );
  }
  log(`  all ${files.length} migration files applied`);
}

/**
 * Removes tokens that vary between two dumps of an IDENTICAL schema, so the diff reports real
 * drift only. Each rule exists because the token it strips was observed to change run-to-run:
 *
 *   - `\restrict` / `\unrestrict` carry a RANDOM per-session token (pg_dump 17+). These are the
 *     tokens that made a manual dump-diff look dirty when the schemas were in fact identical.
 *   - Version banners change when the pinned CLI's pg_dump image is bumped.
 *   - Trailing whitespace and repeated blank lines are formatting noise.
 */
function normalizeDump(sql: string): string {
  return sql
    .split(/\r?\n/)
    .filter((line) => !/^\\(un)?restrict\b/.test(line))
    .filter((line) => !/^--\s*(Dumped from database version|Dumped by pg_dump version)/.test(line))
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function dumpSchema(): Promise<string> {
  await runCli(['db', 'dump', '--local', '--schema', 'public', '-f', dumpPath], 'supabase db dump');
  if (!existsSync(dumpPath)) fail(`supabase db dump reported success but wrote no file at ${dumpPath}`);
  return normalizeDump(readFileSync(dumpPath, 'utf8'));
}

/** First differing line, with context — a 3000-line dump diff is unreadable without this. */
function describeDifference(expected: string, actual: string): string {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const max = Math.max(expectedLines.length, actualLines.length);
  for (let i = 0; i < max; i += 1) {
    if (expectedLines[i] !== actualLines[i]) {
      const from = Math.max(0, i - 3);
      const context = expectedLines
        .slice(from, i)
        .map((l) => `    ${l}`)
        .join('\n');
      return (
        `First difference at line ${i + 1}:\n` +
        `${context}\n` +
        `  expected: ${expectedLines[i] ?? '(end of file)'}\n` +
        `  actual:   ${actualLines[i] ?? '(end of file)'}\n\n` +
        `(expected ${expectedLines.length} lines, actual ${actualLines.length} lines)`
      );
    }
  }
  return 'Files differ only in trailing content.';
}

async function main(): Promise<void> {
  log('Migration validation (AC-086 / V-110)\n');

  // --- Pass 1: apply every migration to an empty database -----------------------------------
  log('[1/4] Resetting local database and applying all migrations from empty...');
  const first = await runCli(['db', 'reset'], 'supabase db reset (first pass)');
  const firstOutput = first.stdout + first.stderr;
  assertNoErrors(firstOutput, 'First reset');
  assertAllMigrationsApplied(firstOutput);

  const firstDump = await dumpSchema();
  log(`  schema dumped (${firstDump.split('\n').length} normalized lines)`);

  // --- Pass 2: the same reset must be repeatable --------------------------------------------
  log('\n[2/4] Resetting a second time (the tooling path must be repeatable)...');
  const second = await runCli(['db', 'reset'], 'supabase db reset (second pass)');
  const secondOutput = second.stdout + second.stderr;
  assertNoErrors(secondOutput, 'Second reset');
  assertAllMigrationsApplied(secondOutput);

  const secondDump = await dumpSchema();

  // --- Pass 3: the two resets must produce byte-identical schemas ---------------------------
  log('\n[3/4] Comparing the two resets...');
  if (firstDump !== secondDump) {
    fail(
      'Two consecutive resets produced DIFFERENT schemas. A migration is not deterministic — it ' +
        'likely depends on pre-existing state or on wall-clock/random values.\n\n' +
        describeDifference(firstDump, secondDump),
    );
  }
  log('  both resets produced an identical schema');

  // --- Pass 4: diff against the checked-in snapshot -----------------------------------------
  log('\n[4/4] Diffing against the checked-in schema snapshot...');
  if (updateSnapshot) {
    writeFileSync(snapshotPath, `${secondDump}\n`, { encoding: 'utf8' });
    log(`  snapshot UPDATED at ${snapshotPath}`);
    log('  review the diff before committing — this file is the drift baseline.');
    return;
  }

  if (!existsSync(snapshotPath)) {
    fail(
      `No schema snapshot at ${snapshotPath}.\n` +
        'Generate it with: npm run db:validate -- --update-snapshot',
    );
  }

  const expected = normalizeDump(readFileSync(snapshotPath, 'utf8'));
  if (expected !== secondDump) {
    fail(
      'The migrated schema does not match the checked-in snapshot.\n\n' +
        'If this change is INTENDED, add a new migration (never edit an applied one) and refresh ' +
        'the snapshot with:\n  npm run db:validate -- --update-snapshot\n\n' +
        describeDifference(expected, secondDump),
    );
  }

  log('  schema matches the checked-in snapshot');
  log('\nOK: all migrations apply cleanly from empty, twice, with no drift.');
}

await main();
