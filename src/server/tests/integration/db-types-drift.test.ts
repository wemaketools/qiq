/**
 * Generated database types drive the Kysely schema, and drift is detectable (T-008, AC-013, V-016).
 *
 * The load-bearing test here is the DRIFT one: it deliberately corrupts the committed generated
 * file, asserts `db:types -- --check` goes red, then restores it. A drift gate that has only ever
 * been observed passing is not a gate.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from './helpers/repo.js';
import { probeLocalStack, suiteTitle, type StackProbe } from './helpers/local-stack.js';

const probe: StackProbe = await probeLocalStack();

const generatedDir = resolve(repoRoot, 'src', 'server', 'lib', 'db', 'generated');
const supabaseTypesPath = resolve(generatedDir, 'supabase-types.ts');
const overridesPath = resolve(generatedDir, 'column-overrides.ts');
/** Everything `db:types` emits — a `--check` run reads all of these from its target directory. */
const GENERATED_FILES = [
  'supabase-types.ts',
  'column-overrides.ts',
  'tenant-scoped-tables.ts',
] as const;
const kyselifyPath = resolve(repoRoot, 'src', 'server', 'lib', 'db', 'kyselify.ts');
const typesPath = resolve(repoRoot, 'src', 'server', 'lib', 'db', 'types.ts');

interface RunResult {
  readonly status: number;
  readonly output: string;
}

function runDbTypes(args: readonly string[] = []): RunResult {
  try {
    const output = execFileSync('npm', ['run', 'db:types', '--', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      shell: true,
      timeout: 5 * 60_000,
    });
    return { status: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('generated DB types are wired into the Kysely schema', () => {
  it('the Kysely Database type is built from the generated Supabase output', () => {
    const kyselify = readFileSync(kyselifyPath, 'utf8');
    const types = readFileSync(typesPath, 'utf8');
    expect(`${kyselify}${types}`).toContain("from './generated/supabase-types.js'");
    expect(`${kyselify}${types}`).toContain("from './generated/column-overrides.js'");
  });

  it('the generated files are marked as generated so nobody hand-edits them', () => {
    for (const path of [supabaseTypesPath, overridesPath]) {
      expect(readFileSync(path, 'utf8')).toContain('DO NOT EDIT BY HAND');
    }
  });
});

describe.skipIf(!probe.available)(suiteTitle('npm run db:types', probe), () => {
  it('regenerates types from the local schema with exit code 0', () => {
    // Writes to a per-run temp directory via `--out`, NOT the committed files (F-008-7).
    //
    // This is the only write-mode `db:types` invocation in the suite. It used to regenerate the
    // real generated files and restore them from an in-memory snapshot in a `finally`, which left
    // the committed artifacts corruptible two ways: an interrupted run never reaches the restore,
    // and two concurrent runs interleave — B snapshots while A's regenerated content is on disk,
    // so B's "restore" writes A's content back permanently. The second happened for real during
    // three parallel implementor tasks and surfaced later as unrelated typecheck failures, because
    // T-008's `everySchemaTableIsListed` guard reads these files. Writing elsewhere removes the
    // window entirely rather than narrowing it.
    const outDir = mkdtempSync(join(tmpdir(), 'db-types-'));
    const committedBefore = readFileSync(supabaseTypesPath, 'utf8');
    try {
      const result = runDbTypes(['--out', outDir]);
      expect(result.status, result.output).toBe(0);

      // Generation really happened, in the temp dir...
      expect(readFileSync(resolve(outDir, 'supabase-types.ts'), 'utf8')).toContain(
        'DO NOT EDIT BY HAND',
      );
      // ...and the committed artifact was not touched. Without this assertion the redirect could
      // silently stop working and we would be back to the corruption window with a green test.
      expect(readFileSync(supabaseTypesPath, 'utf8')).toBe(committedBefore);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('reports no drift when the committed types match the schema', () => {
    const result = runDbTypes(['--check']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('up to date');
  });

  /**
   * Corrupt a COPY, never the committed artifact (F-008-8).
   *
   * These two cases used to corrupt-and-restore the real generated files in place. That is the same
   * window F-008-7 closed for the write-mode case above — smaller blast radius (the corruption is
   * deterministic and immediately red on `db:types:check`), but still a window in which an
   * interrupted or interleaved run leaves the committed tree broken for everything downstream.
   * `--check` honours `--out`, so the whole exercise moves off the committed files.
   */
  function withGeneratedCopy(run: (dir: string, file: (name: string) => string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'db-types-check-'));
    const committedBefore = GENERATED_FILES.map((name) =>
      readFileSync(resolve(generatedDir, name), 'utf8'),
    );
    try {
      for (const name of GENERATED_FILES) {
        copyFileSync(resolve(generatedDir, name), resolve(dir, name));
      }
      run(dir, (name) => resolve(dir, name));

      // The committed artifacts must be untouched by anything this case did.
      GENERATED_FILES.forEach((name, i) => {
        expect(readFileSync(resolve(generatedDir, name), 'utf8')).toBe(committedBefore[i]);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('DETECTS DRIFT: a stale type file fails the check with exit 1', () => {
    withGeneratedCopy((dir, file) => {
      // Baseline: an untouched copy passes, so the failure below is the corruption and not the copy.
      expect(runDbTypes(['--check', '--out', dir]).status).toBe(0);

      const path = file('supabase-types.ts');
      const original = readFileSync(path, 'utf8');
      writeFileSync(
        path,
        original.replace('export type Json', 'export type Drifted = never\nexport type Json'),
        'utf8',
      );

      const result = runDbTypes(['--check', '--out', dir]);

      expect(result.status, 'stale generated types must fail the check').not.toBe(0);
      expect(result.output).toContain('do not match the local schema');
    });
  });

  it('DETECTS DRIFT in the numeric-column overrides too', () => {
    withGeneratedCopy((dir, file) => {
      expect(runDbTypes(['--check', '--out', dir]).status).toBe(0);

      const path = file('column-overrides.ts');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace('quoted_premium', 'not_a_column'),
        'utf8',
      );
      const result = runDbTypes(['--check', '--out', dir]);
      expect(result.status, 'stale overrides must fail the check').not.toBe(0);
    });
  });
});
