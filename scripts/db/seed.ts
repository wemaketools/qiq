#!/usr/bin/env tsx
/**
 * Standalone seed runner (T-006, M-11, Q-8, AC-009).
 *
 * `supabase db reset` already applies `supabase/seed.sql` locally. This script is the OTHER half
 * of Q-8: the same seed, runnable as a deploy step against any environment, where no Supabase CLI
 * reset exists and dropping the database is not an option.
 *
 * It does not own a second copy of the seed data. It reads `supabase/seed.sql`, extracts the
 * block between the BASELINE markers, and executes it — so local resets and deployed runs cannot
 * drift apart, because there is only one set of statements.
 *
 * Usage:
 *   npm run db:seed                      seed the configured (local) database
 *   npm run db:seed -- --baseline        the same thing, stated explicitly
 *   npm run db:seed -- --env=staging     required to seed anything that is not local
 *
 * SAFETY (M-11: "never run automatically in production"). The target environment comes from the
 * loaded configuration, never from a flag; a non-local target additionally requires the operator
 * to name it with `--env=`. See scripts/db/seed-target.ts for the decision matrix.
 *
 * CONNECTION: DIRECT_DATABASE_URL, never DATABASE_URL. Admin/DDL-adjacent work must not go through
 * the transaction pooler (A-8).
 *
 * IDEMPOTENCY: every statement in the baseline block is conflict-tolerant, so re-running converges
 * instead of duplicating or erroring. The whole block runs in ONE transaction: a seed that fails
 * halfway leaves the database exactly as it found it, which is what makes a retry safe.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { getConfig, ConfigurationError, type AppConfig } from '../../src/server/lib/config/index.js';
import { decideSeedTarget } from './seed-target.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const seedSqlPath = resolve(repoRoot, 'supabase', 'seed.sql');

const BEGIN_MARKER = '-- >>> QUOTEIQ BASELINE SEED BEGIN';
const END_MARKER = '-- <<< QUOTEIQ BASELINE SEED END';

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`\nSEED FAILED\n${message}\n`);
  process.exit(1);
}

/** `--env=staging` -> "staging"; `--env staging` -> "staging"; absent -> null. */
export function parseEnvFlag(argv: readonly string[]): string | null {
  const inline = argv.find((arg) => arg.startsWith('--env='));
  if (inline !== undefined) return inline.slice('--env='.length);

  const index = argv.indexOf('--env');
  if (index === -1) return null;
  return argv[index + 1] ?? '';
}

/**
 * Extracts the baseline block. T-041 will add demo-data layers to the same file OUTSIDE these
 * markers, so this must keep returning the baseline only.
 */
export function extractBaselineSql(seedSql: string): string {
  const begin = seedSql.indexOf(BEGIN_MARKER);
  const end = seedSql.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `Could not find the baseline block in supabase/seed.sql (expected "${BEGIN_MARKER}" ... "${END_MARKER}").`,
    );
  }

  const block = seedSql.slice(begin + BEGIN_MARKER.length, end).trim();
  if (!/insert\s+into/i.test(block)) {
    throw new Error('The baseline block in supabase/seed.sql contains no INSERT statements.');
  }
  return block;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const unknown: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--baseline' || arg.startsWith('--env=')) continue;
    if (arg === '--env') {
      index += 1; // its value
      continue;
    }
    unknown.push(arg);
  }
  if (unknown.length > 0) {
    fail(
      `Unknown argument(s): ${unknown.join(', ')}\n` +
        'Usage: npm run db:seed -- [--baseline] [--env=<environment>]',
    );
  }

  let config: AppConfig;
  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      fail(`${error.message}\n\nSeeding needs DIRECT_DATABASE_URL at minimum.`);
    }
    throw error;
  }

  const decision = decideSeedTarget(config.appEnv, parseEnvFlag(argv));
  if (!decision.allowed) {
    // Not a crash — a refusal. Non-zero so no pipeline mistakes it for a completed seed.
    process.stderr.write(`\n${decision.reason}\n`);
    process.exit(1);
  }

  const baselineSql = extractBaselineSql(readFileSync(seedSqlPath, 'utf8'));

  log(`Baseline seed (permission catalog + global default reference template)`);
  log(`  target environment: ${decision.appEnv}`);
  log(`  connection: DIRECT_DATABASE_URL (direct, not the pooler)`);

  // Never log the connection string itself: it carries the database password.
  const client = new pg.Client({ connectionString: config.database.directUrl });
  await client.connect();

  try {
    await client.query('begin');
    await client.query(baselineSql);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    fail(`Executing the baseline block failed; the transaction was rolled back.\n${message}`);
  } finally {
    await client.end();
  }

  const counts = await summarize(config.database.directUrl);
  log(`  permissions: ${counts.permissions}`);
  log(`  default_reference_items: ${counts.defaultReferenceItems}`);
  log('OK: baseline seed applied (re-runnable; re-running converges).');
}

async function summarize(
  connectionString: string,
): Promise<{ permissions: number; defaultReferenceItems: number }> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ permissions: string; default_reference_items: string }>(
      'select (select count(*) from permissions) as permissions, ' +
        '(select count(*) from default_reference_items) as default_reference_items',
    );
    const row = result.rows[0];
    return {
      permissions: Number(row?.permissions ?? 0),
      defaultReferenceItems: Number(row?.default_reference_items ?? 0),
    };
  } finally {
    await client.end();
  }
}

await main();
