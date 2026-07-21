/**
 * Static guard against session-scoped state in server code (T-008, N-03, R-3, AC-012).
 *
 * Supavisor transaction pooling hands a different server backend to each transaction, so anything
 * that lives in a SESSION is silently lost or applied to the wrong client. None of these
 * constructs will fail loudly in a local direct-connection test, which is exactly why a source
 * scan carries the guarantee: the failure mode only appears in production.
 *
 * Transaction-scoped equivalents remain allowed and are listed as such below.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from './helpers/repo.js';

const serverRoot = resolve(repoRoot, 'src', 'server');

function collectTypeScriptFiles(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const absolute = join(dir, name);
    if (statSync(absolute).isDirectory()) {
      collectTypeScriptFiles(absolute, into);
    } else if (name.endsWith('.ts') && name !== 'db-session-safety.test.ts') {
      // This file names every banned construct in order to test for it.
      into.push(absolute);
    }
  }
  return into;
}

const files = collectTypeScriptFiles(serverRoot);

interface Banned {
  readonly label: string;
  /** Receives ONE whitespace-normalised SQL statement, lower-cased. */
  readonly detect: (statement: string) => boolean;
  readonly allowed: string;
}

const BANNED: readonly Banned[] = [
  {
    label: 'LISTEN/NOTIFY',
    detect: (statement) => /^(listen|unlisten|notify)\s+[a-z_"]/.test(statement),
    allowed:
      'use pgmq / the alerts tables; asynchronous notification needs a session a pooler will not keep',
  },
  {
    label: 'session-level advisory locks',
    // pg_advisory_lock / pg_advisory_unlock / pg_try_advisory_lock, but NOT the _xact_ variants,
    // whose names continue "advisory_xact_" and therefore never match.
    detect: (statement) => /pg_(try_)?advisory_(unlock|lock)\s*\(/.test(statement),
    allowed: 'use pg_advisory_xact_lock(), which is released at COMMIT and is pooler-safe',
  },
  {
    label: 'session-scoped SET',
    // Only a SET that STARTS a statement is a configuration SET. `update t set c = ...` and
    // `on conflict do update set c = ...` are ordinary DML and must not be flagged.
    detect: (statement) => /^set\s+(?!local\b)/.test(statement),
    allowed: 'use SET LOCAL inside an explicit transaction (the seam T-014 uses for RLS context)',
  },
  {
    label: 'session-lifetime temporary tables',
    detect: (statement) =>
      /^create\s+(global\s+|local\s+)?temp(orary)?\s+table\b/.test(statement) &&
      !/on\s+commit\s+drop/.test(statement),
    allowed: 'use CREATE TEMP TABLE ... ON COMMIT DROP inside one transaction, or a CTE',
  },
];

/**
 * Extracts SQL-bearing text — the `sql` template tag and raw query string literals — and splits it
 * into individual statements. Scanning whole files would drown in false positives from ordinary
 * TypeScript (`set` accessors, `notify` callbacks); splitting on `;` is what lets the rules above
 * distinguish a configuration `SET` from the `SET` clause of an UPDATE.
 *
 * KNOWN LIMIT: SQL assembled from concatenated fragments or built at runtime is invisible here.
 * This scan raises the cost of introducing session state; it does not make it impossible.
 */
function sqlStatements(source: string): string[] {
  const chunks: string[] = [];
  for (const match of source.matchAll(/sql[a-zA-Z<>{}\s]*`([\s\S]*?)`/g)) chunks.push(match[1] ?? '');
  // A plain string literal counts as SQL only if it OPENS with a SQL verb. `set` additionally has
  // to look like `set <name> = ` / `set <name> to `, otherwise English prose beginning with "Set
  // these in .env.local..." is scanned as a configuration statement.
  const sqlLiteral =
    /(['"`])((?:(?:select|insert|update|delete|with|create|prepare|listen|notify)\s|set\s+[a-z_][a-z0-9_.]*\s*(?:=|to\s))[\s\S]*?)\1/gi;
  for (const match of source.matchAll(sqlLiteral)) {
    chunks.push(match[2] ?? '');
  }

  return chunks
    .join(';\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((statement) => statement.length > 0);
}

describe('server code contains no transaction-pooling-hostile session state', () => {
  it('found TypeScript sources to scan', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('found SQL to scan, so a green result means something', () => {
    expect(files.length).toBeGreaterThan(20);
    const total = files.reduce(
      (count, file) => count + sqlStatements(readFileSync(file, 'utf8')).length,
      0,
    );
    expect(total).toBeGreaterThan(50);
  });

  it.each(BANNED)('uses no $label', ({ detect, allowed }) => {
    const offenders: string[] = [];
    for (const file of files) {
      const statements = sqlStatements(readFileSync(file, 'utf8'));
      if (statements.some(detect)) offenders.push(relative(repoRoot, file).split(sep).join('/'));
    }

    expect(offenders, `Transaction pooling forbids this. Instead: ${allowed}.`).toEqual([]);
  });

  it('SELF-CHECK: the scanner detects each banned construct when one is present', () => {
    // Without this, all four assertions above could be passing because the scanner is broken.
    const offending: Record<string, string> = {
      'LISTEN/NOTIFY': 'const q = sql`listen lead_changes`;',
      'session-level advisory locks': 'const q = sql`select pg_advisory_lock(1)`;',
      'session-scoped SET': 'const q = sql`set search_path = public`;',
      'session-lifetime temporary tables': 'const q = sql`create temp table t as select 1`;',
    };

    for (const rule of BANNED) {
      const sample = offending[rule.label] ?? '';
      const detected = sqlStatements(sample).some(rule.detect);
      expect(detected, `scanner failed to detect: ${rule.label}`).toBe(true);
    }
  });

  it('SELF-CHECK: the scanner permits the transaction-scoped equivalents', () => {
    const allowedSamples = [
      'const q = sql`set local app.tenant_id = 1`;',
      'const q = sql`select pg_advisory_xact_lock(1)`;',
      'const q = sql`create temp table t on commit drop as select 1`;',
    ];
    for (const sample of allowedSamples) {
      const statements = sqlStatements(sample);
      const hits = BANNED.filter((rule) => statements.some(rule.detect)).map((rule) => rule.label);
      expect(hits, `false positive on: ${sample}`).toEqual([]);
    }
  });

  it('SELF-CHECK: ordinary DML using a SET clause is not mistaken for a configuration SET', () => {
    const dml = [
      "const q = sql`update leads set status_id = 1 where id = 2`;",
      "const q = sql`insert into t (a) values (1) on conflict (a) do update set a = excluded.a`;",
    ];
    for (const sample of dml) {
      const statements = sqlStatements(sample);
      const hits = BANNED.filter((rule) => statements.some(rule.detect)).map((rule) => rule.label);
      expect(hits, `false positive on: ${sample}`).toEqual([]);
    }
  });
});
