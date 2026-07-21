/**
 * Baseline seed: content parity, idempotency and production safety (T-006, AC-009/AC-086,
 * V-010/V-110).
 *
 * Three things can go wrong here, and all three are SILENT:
 *   1. a mistyped or missing permission code — authorization misbehaves at runtime, nothing errors;
 *   2. a wrong `canonical_key`/`reporting_category` on a guarded status — every conversion metric
 *      (AC-073 Lead-to-Quote, AC-074 Quote-to-Win) resolves the wrong row, still with no error;
 *   3. a non-converging seed — re-running duplicates rows or blows up on a deploy, not locally.
 *
 * So the expectations are NOT taken from `supabase/seed.sql` (that would be circular). They come
 * from the frozen `helpers/baseline-seed-reference.ts` inventory (captured verbatim from the
 * original .NET provisioning sources before those were removed at cutover), and are compared
 * key-for-key with the actual database contents.
 *
 * ON THE RESET PATH: this suite deliberately does NOT run `supabase db reset` — it is destructive
 * and other suites (and, at the time of writing, a parallel task) share this database. Instead
 * `describes the reset wiring` asserts config.toml routes `supabase/seed.sql` through the reset,
 * and `arrives already seeded` asserts the database is ALREADY fully seeded before this suite
 * touches it — which is exactly the post-`supabase db reset` state, and fails loudly if the reset
 * path stopped seeding.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  readBaselineReferenceItems,
  readBaselinePermissionCatalog,
  referenceItemKey,
  type DefaultReferenceItemReference,
} from '../helpers/baseline-seed-reference.js';
import { probeLocalStack, suiteTitle, type StackProbe } from './helpers/local-stack.js';
import { repoRoot, runNpmScript } from './helpers/repo.js';

const probe: StackProbe = await probeLocalStack();
const stack = probe.available ? probe.stack : null;

const expectedPermissions = readBaselinePermissionCatalog();
const expectedItems = readBaselineReferenceItems();

interface PermissionRow {
  code: string;
  category: string;
  description: string;
}

interface ReferenceItemRow {
  list_type: string;
  name: string;
  display_order: number;
  is_active: boolean;
  is_broker_channel: boolean | null;
  default_product_line_key: string | null;
  reporting_category: string | null;
  canonical_key: string | null;
  is_terminal: boolean;
}

/**
 * Content digest excluding only the two genuinely volatile columns (`created_at`/`updated_at`,
 * which are wall-clock at insert). Identity ids ARE included: two resets must reproduce them,
 * which is what makes AC-086's "identical logical state" meaningful.
 */
const DIGEST_SQL = `
  select
    (select count(*) from permissions)::int as permission_count,
    (select count(*) from default_reference_items)::int as item_count,
    (select md5(coalesce(string_agg(code || '|' || category || '|' || description, E'\\n' order by code), ''))
       from permissions) as permission_digest,
    (select md5(coalesce(string_agg(
             concat_ws('|', id::text, list_type, name, display_order::text, is_active::text,
                       coalesce(is_broker_channel::text, '~'),
                       coalesce(default_product_line_key, '~'),
                       coalesce(reporting_category, '~'),
                       coalesce(canonical_key, '~'),
                       is_terminal::text),
             E'\\n' order by id), ''))
       from default_reference_items) as item_digest
`;

interface Digest {
  permission_count: number;
  item_count: number;
  permission_digest: string;
  item_digest: string;
}

let pool: pg.Pool | null = null;

async function query<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
  if (pool === null) throw new Error('pool not initialised');
  const result = await pool.query<T>(sql);
  return result.rows;
}

async function digest(): Promise<Digest> {
  const [row] = await query<Digest>(DIGEST_SQL);
  if (row === undefined) throw new Error('digest query returned no row');
  return row;
}

/**
 * Runs the real `npm run db:seed` and proves it actually executed: a spawn that silently failed
 * to start would otherwise satisfy "the row counts did not change" perfectly.
 */
function runSeed(): ReturnType<typeof runNpmScript> {
  const result = runNpmScript('db:seed', 180_000);
  expect(result.output, `db:seed produced no evidence of running:\n${result.output}`).toContain(
    'OK: baseline seed applied',
  );
  expect(result.output).toContain('target environment: local');
  return result;
}

beforeAll(() => {
  if (stack !== null) pool = new pg.Pool({ connectionString: stack.dbUrl, max: 2 });
});

afterAll(async () => {
  await pool?.end();
});

describe.skipIf(!probe.available)(suiteTitle('baseline seed content', probe), () => {
  it('arrives already seeded — the reset path applied supabase/seed.sql', async () => {
    // No seed has been run by this suite yet: whatever is here came from `supabase db reset`
    // (or a previous standalone run), which is the state AC-009 requires.
    const before = await digest();

    expect(
      before.permission_count,
      'permissions table is not fully seeded — run `npm run supabase:reset` (or `npm run db:seed`)',
    ).toBe(expectedPermissions.length);
    expect(before.item_count).toBe(expectedItems.length);
  });

  it('contains exactly the .NET permission catalog, code for code', async () => {
    const rows = await query<PermissionRow>('select code, category, description from permissions');

    const actual = rows.map((r) => r.code).sort();
    const expected = expectedPermissions.map((p) => p.code).sort();

    // Whole-set equality, not a count: a swapped pair of codes keeps the count identical.
    expect(actual).toEqual(expected);
  });

  it('seeds the category and description of every permission from the .NET catalog', async () => {
    const rows = await query<PermissionRow>('select code, category, description from permissions');
    const byCode = new Map(rows.map((r) => [r.code, r]));

    const mismatched = expectedPermissions.filter((expectedPermission) => {
      const row = byCode.get(expectedPermission.code);
      return (
        row === undefined ||
        row.category !== expectedPermission.category ||
        row.description !== expectedPermission.description
      );
    });

    expect(mismatched.map((p) => p.code)).toEqual([]);
  });

  it('parses a non-trivial catalog from the .NET source', () => {
    // Guards the guard: a parser that silently returned [] would make every assertion above pass.
    expect(expectedPermissions.length).toBeGreaterThan(50);
    expect(new Set(expectedPermissions.map((p) => p.code)).size).toBe(expectedPermissions.length);
  });

  it('contains exactly the .NET global default reference template, row for row', async () => {
    const rows = await query<ReferenceItemRow>(
      'select list_type, name, display_order, is_active, is_broker_channel, ' +
        'default_product_line_key, reporting_category, canonical_key, is_terminal ' +
        'from default_reference_items',
    );

    const actual = rows.map((r) => referenceItemKey({ listType: r.list_type, name: r.name })).sort();
    const expected = expectedItems.map(referenceItemKey).sort();

    expect(actual).toEqual(expected);
  });

  it('seeds every template row with the .NET display order, flags and channel marker', async () => {
    const rows = await query<ReferenceItemRow>(
      'select list_type, name, display_order, is_active, is_broker_channel, ' +
        'default_product_line_key, reporting_category, canonical_key, is_terminal ' +
        'from default_reference_items',
    );
    const byKey = new Map(
      rows.map((r) => [referenceItemKey({ listType: r.list_type, name: r.name }), r]),
    );

    const differences: string[] = [];
    for (const expectedItem of expectedItems) {
      const row = byKey.get(referenceItemKey(expectedItem));
      if (row === undefined) {
        differences.push(`${referenceItemKey(expectedItem)}: missing`);
        continue;
      }
      if (row.display_order !== expectedItem.displayOrder) {
        differences.push(
          `${referenceItemKey(expectedItem)}: display_order ${row.display_order} != ${expectedItem.displayOrder}`,
        );
      }
      if (row.is_broker_channel !== expectedItem.isBrokerChannel) {
        differences.push(
          `${referenceItemKey(expectedItem)}: is_broker_channel ${String(row.is_broker_channel)} != ${String(expectedItem.isBrokerChannel)}`,
        );
      }
      if (row.is_terminal !== expectedItem.isTerminal) {
        differences.push(`${referenceItemKey(expectedItem)}: is_terminal mismatch`);
      }
      if (!row.is_active) differences.push(`${referenceItemKey(expectedItem)}: seeded inactive`);
      if (row.default_product_line_key !== null) {
        differences.push(`${referenceItemKey(expectedItem)}: unexpected default_product_line_key`);
      }
    }

    expect(differences).toEqual([]);
  });

  it('seeds guarded lead/quote statuses with the exact canonical keys and reporting categories', async () => {
    // P-04's load-bearing assertion: dashboards resolve statuses by canonical_key, so a typo here
    // silently breaks AC-073/AC-074 rather than failing.
    const rows = await query<ReferenceItemRow>(
      "select list_type, name, canonical_key, reporting_category, is_terminal from default_reference_items " +
        "where list_type in ('lead_status', 'quote_status')",
    );

    const shape = (
      item: Pick<
        DefaultReferenceItemReference,
        'listType' | 'name' | 'canonicalKey' | 'reportingCategory' | 'isTerminal'
      >,
    ): string =>
      `${item.listType}/${item.name} -> ${String(item.canonicalKey)}/${String(item.reportingCategory)}/${String(item.isTerminal)}`;

    const actual = rows
      .map((r) =>
        shape({
          listType: r.list_type,
          name: r.name,
          canonicalKey: r.canonical_key,
          reportingCategory: r.reporting_category,
          isTerminal: r.is_terminal,
        }),
      )
      .sort();
    const expected = expectedItems
      .filter((i) => i.listType === 'lead_status' || i.listType === 'quote_status')
      .map(shape)
      .sort();

    expect(expected.length).toBe(18);
    expect(actual).toEqual(expected);
    // Every status carries both guards; a null would slip past a set comparison of names alone.
    expect(rows.every((r) => r.canonical_key !== null && r.reporting_category !== null)).toBe(true);
  });

  it('leaves canonical keys unique within each list, as the reference_items constraint demands', async () => {
    const duplicates = await query<{ list_type: string; canonical_key: string; n: string }>(
      'select list_type, canonical_key, count(*) as n from default_reference_items ' +
        'where canonical_key is not null group by list_type, canonical_key having count(*) > 1',
    );

    expect(duplicates).toEqual([]);
  });
});

describe.skipIf(!probe.available)(suiteTitle('baseline seed idempotency', probe), () => {
  it('converges: three consecutive runs leave row counts and content identical', async () => {
    const before = await digest();

    const first = runSeed();
    expect(first.status, `first db:seed failed:\n${first.output}`).toBe(0);
    const afterFirst = await digest();

    const second = runSeed();
    expect(second.status, `second db:seed failed:\n${second.output}`).toBe(0);
    const afterSecond = await digest();

    expect(afterFirst).toEqual(before);
    expect(afterSecond).toEqual(before);
    // Digests are only meaningful if they are actually digesting something.
    expect(before.permission_digest).not.toBe('d41d8cd98f00b204e9800998ecf8427e');
  }, 600_000);

  it('reports success rather than a duplicate-key error on a re-run', () => {
    const result = runSeed();

    expect(result.status).toBe(0);
    expect(result.output).not.toMatch(/duplicate key value|already exists/i);
  }, 180_000);
});

describe('baseline seed wiring', () => {
  const seedSqlPath = resolve(repoRoot, 'supabase/seed.sql');
  const seedSql = existsSync(seedSqlPath) ? readFileSync(seedSqlPath, 'utf8') : '';

  it('is routed through supabase db reset by config.toml', () => {
    const config = readFileSync(resolve(repoRoot, 'supabase/config.toml'), 'utf8');

    expect(config).toMatch(/^\s*enabled\s*=\s*true/m);
    expect(config).toMatch(/sql_paths\s*=\s*\[[^\]]*"\.\/seed\.sql"/);
  });

  it('writes both baseline tables from supabase/seed.sql', () => {
    expect(seedSql).toMatch(/insert\s+into\s+permissions/i);
    expect(seedSql).toMatch(/insert\s+into\s+default_reference_items/i);
  });

  it('makes every baseline insert conflict-tolerant so a re-run converges', () => {
    // Comments are stripped FIRST. The file's header explains its ON CONFLICT strategy in prose,
    // and a mutation test showed that prose alone satisfied this check while the actual INSERT had
    // lost its ON CONFLICT clause — the scan has to look at statements, not at documentation.
    const statements = seedSql
      .split(/\r?\n/)
      .filter((line) => !/^\s*--/.test(line))
      .join('\n');
    const inserts = [...statements.matchAll(/insert\s+into\s+(\w+)/gi)].map((m) => m[1] as string);

    expect(inserts).toEqual(expect.arrayContaining(['permissions', 'default_reference_items']));
    for (const statement of statements.split(/;\s*\n/)) {
      if (!/insert\s+into/i.test(statement)) continue;
      expect(statement, `an INSERT without ON CONFLICT is not idempotent:\n${statement}`).toMatch(
        /on\s+conflict/i,
      );
    }
  });

  it('delimits the baseline block the standalone script extracts', () => {
    expect(seedSql).toContain('QUOTEIQ BASELINE SEED BEGIN');
    expect(seedSql).toContain('QUOTEIQ BASELINE SEED END');
  });

  /**
   * The database assertions above cannot catch a row DELETED from seed.sql: seeding never
   * removes rows, so a dropped permission code stays in an already-seeded database until the
   * next reset — the file would be wrong for a whole development cycle while every test stayed
   * green. These two checks compare the FILE against the .NET reference directly, so a dropped
   * or mistyped row fails immediately, with no reset required.
   */
  it('lists exactly the .NET permission catalog in seed.sql itself', () => {
    const parsed = [
      ...seedSql.matchAll(/^\s*\('([^']*)', '([^']*)', '([^']*)'\),?\s*$/gm),
    ].map((m) => `${m[1] as string}|${m[2] as string}|${m[3] as string}`);

    const expected = expectedPermissions.map((p) => `${p.code}|${p.category}|${p.description}`);

    expect(parsed.length).toBe(expected.length);
    expect(parsed.sort()).toEqual([...expected].sort());
  });

  it('lists exactly the .NET default reference template in seed.sql itself', () => {
    const pattern =
      /^\s*\('([^']*)', '([^']*)', (\d+), (true|false), (true|false|null), (null|'[^']*'), (null|'[^']*'), (null|'[^']*'), (true|false), now\(\), now\(\)\),?\s*$/gm;
    const unquote = (value: string): string | null =>
      value === 'null' ? null : value.slice(1, -1);

    const parsed = [...seedSql.matchAll(pattern)].map((m) =>
      [
        m[1] as string,
        m[2] as string,
        m[3] as string,
        m[4] as string,
        m[5] as string,
        unquote(m[6] as string) ?? '~',
        unquote(m[7] as string) ?? '~',
        unquote(m[8] as string) ?? '~',
        m[9] as string,
      ].join('|'),
    );

    const expected = expectedItems.map((item) =>
      [
        item.listType,
        item.name,
        String(item.displayOrder),
        'true', // is_active
        item.isBrokerChannel === null ? 'null' : String(item.isBrokerChannel),
        '~', // default_product_line_key is unused until cover-type defaults exist
        item.reportingCategory ?? '~',
        item.canonicalKey ?? '~',
        String(item.isTerminal),
      ].join('|'),
    );

    expect(parsed.length).toBe(expected.length);
    expect(parsed.sort()).toEqual([...expected].sort());
  });

  it('exposes db:seed as a real command rather than a not-implemented stub', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['db:seed']).toBeTruthy();
    expect(pkg.scripts?.['db:seed']).not.toContain('not-implemented');
  });

  it('documents db:seed in docs/local-development.md', () => {
    const docs = readFileSync(resolve(repoRoot, 'docs/local-development.md'), 'utf8');

    expect(docs).toContain('db:seed');
    expect(docs).toMatch(/--env=/);
  });
});

describe('baseline seed production safety', () => {
  const tsxCli = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
  let tempDir: string | null = null;

  /**
   * Runs the real CLI with an extra env file that overrides `APP_ENV`, which is how a deployed
   * target is simulated without touching this process's environment.
   */
  function runSeedAgainst(appEnv: string, args: readonly string[]): { status: number | null; output: string } {
    if (tempDir === null) tempDir = mkdtempSync(join(tmpdir(), 'quoteiq-seed-guard-'));
    const envFile = join(tempDir, `${appEnv}.env`);
    writeFileSync(envFile, `APP_ENV=${appEnv}\n`, 'utf8');

    const run = spawnSync(
      process.execPath,
      [
        tsxCli,
        '--env-file-if-exists=.env.local',
        `--env-file=${envFile}`,
        'scripts/db/seed.ts',
        ...args,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 180_000, windowsHide: true },
    );

    return { status: run.status, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}` };
  }

  afterAll(() => {
    if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves the tsx entrypoint the guard test drives', () => {
    expect(existsSync(tsxCli)).toBe(true);
  });

  it('refuses to seed a production target with no explicit confirmation', () => {
    const result = runSeedAgainst('production', ['--baseline']);

    expect(result.status, `expected a refusal, got:\n${result.output}`).not.toBe(0);
    expect(result.output).toMatch(/refus/i);
    expect(result.output).toContain('--env=production');
  }, 180_000);

  it('refuses a staging target confirmed as some other environment', () => {
    const result = runSeedAgainst('staging', ['--baseline', '--env=local']);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/refus/i);
  }, 180_000);

  it('writes nothing to the database when it refuses', async () => {
    if (!probe.available) return;
    const before = await digest();

    runSeedAgainst('production', ['--baseline']);

    expect(await digest()).toEqual(before);
  }, 180_000);
});
