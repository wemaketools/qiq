#!/usr/bin/env tsx
/**
 * CI test-run gate (T-010).
 *
 * WHY THIS EXISTS: the integration suites deliberately skip themselves when the local Supabase
 * stack is unreachable (see src/server/tests/integration/helpers/local-stack.ts). That keeps a
 * laptop without Docker usable, but it means `vitest run` EXITS 0 WHEN NOTHING RAN. In CI the
 * stack is always started, so a skip means the pipeline is reporting green on tests that never
 * executed. This wrapper turns that into a hard failure by asserting the exact expected test
 * count and refusing to tolerate a single skipped/todo test.
 *
 * It also catches the opposite failure mode: a suite that silently stops being collected (a
 * jsdom/hoisting regression has already caused exactly that in this repo) shows up as a count
 * shortfall rather than as a green run.
 *
 * Usage:
 *   tsx scripts/ci/assert-test-run.ts --label backend --cwd . --min-tests 595
 *   tsx scripts/ci/assert-test-run.ts --label ui --cwd src/ui --min-tests 492
 *
 * WHY A FLOOR AND NOT AN EXACT COUNT: an exact count goes red every time anyone legitimately
 * adds a test, on a repository where several tasks land tests in parallel. A gate that cries
 * wolf on correct work gets deleted, and then the real hazard is unguarded. The floor still
 * catches a suite that stops being collected, which is the failure this is defending against;
 * the zero-skip assertion below, not the count, is what makes an unavailable Supabase stack a
 * hard failure. Raise the floor deliberately as suites grow.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Options {
  readonly label: string;
  readonly cwd: string;
  readonly minTests: number;
}

function parseArgs(argv: readonly string[]): Options {
  let label = '';
  let cwd = '.';
  let minTests = Number.NaN;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--label' && next) {
      label = next;
      i += 1;
    } else if (arg === '--cwd' && next) {
      cwd = next;
      i += 1;
    } else if (arg === '--min-tests' && next) {
      minTests = Number.parseInt(next, 10);
      i += 1;
    } else {
      throw new Error(`Unrecognised argument: ${arg}`);
    }
  }

  if (!label) throw new Error('--label is required');
  if (!Number.isInteger(minTests) || minTests <= 0) {
    throw new Error('--min-tests must be a positive integer');
  }
  return { label, cwd, minTests };
}

interface VitestJsonReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  testResults?: readonly { name?: string; status?: string; assertionResults?: readonly { status?: string; fullName?: string }[] }[];
}

function fail(message: string): never {
  console.error(`\n[assert-test-run] FAILED: ${message}\n`);
  process.exit(1);
}

/**
 * Test files present on disk for this label, so the report can be checked against reality.
 *
 * Mirrors the vitest `include` globs: backend `src/server/tests/{unit,integration}` and the UI's
 * co-located `*.test.ts(x)`. Returns [] if the roots are absent, so the caller skips the check
 * rather than failing on an unexpected layout.
 */
function discoverTestFiles(options: Options): string[] {
  const roots =
    options.label === 'ui'
      ? [resolve(options.cwd, 'src')]
      : [resolve(repoRoot, 'src/server/tests/unit'), resolve(repoRoot, 'src/server/tests/integration')];
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // root absent — treated as "cannot determine", not as a failure
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (/\.test\.tsx?$/.test(entry.name)) {
        found.push(resolve(full));
      }
    }
  };
  roots.forEach(walk);
  return found;
}

const options = parseArgs(process.argv.slice(2));
const workingDirectory = resolve(repoRoot, options.cwd);
const reportDirectory = mkdtempSync(join(tmpdir(), 'quoteiq-vitest-'));
const reportPath = join(reportDirectory, 'report.json');

try {
  // Two reporters: `default` keeps the CI log readable, `json` gives machine-checkable counts.
  const run = spawnSync(
    `npx vitest run --reporter=default --reporter=json --outputFile.json="${reportPath}"`,
    { cwd: workingDirectory, encoding: 'utf8', shell: true, stdio: 'inherit' },
  );

  let report: VitestJsonReport;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8')) as VitestJsonReport;
  } catch (error) {
    fail(
      `[${options.label}] vitest produced no readable JSON report at ${reportPath} ` +
        `(exit code ${String(run.status)}). The run almost certainly crashed before collection. ` +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const total = report.numTotalTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const pending = report.numPendingTests ?? 0;
  const todo = report.numTodoTests ?? 0;
  const skipped = pending + todo;

  console.error(
    `[assert-test-run] ${options.label}: total=${total} passed=${passed} failed=${failed} ` +
      `skipped=${skipped} (require >= ${options.minTests} total, 0 skipped)`,
  );

  if (failed > 0 || run.status !== 0) {
    fail(`[${options.label}] vitest reported ${failed} failing test(s), exit code ${String(run.status)}.`);
  }

  if (skipped > 0) {
    const skippedNames = (report.testResults ?? [])
      .flatMap((file) => (file.assertionResults ?? []).filter((a) => a.status !== 'passed'))
      .map((a) => `  - ${a.fullName ?? '(unnamed)'} [${a.status ?? 'unknown'}]`)
      .slice(0, 40);
    const skippedFiles = (report.testResults ?? [])
      .filter((file) => file.status === 'skipped' || file.status === 'pending')
      .map((file) => `  - ${file.name ?? '(unnamed file)'}`)
      .slice(0, 40);
    fail(
      `[${options.label}] ${skipped} test(s) were SKIPPED. In CI every dependency (Docker, the ` +
        `Supabase stack) is provisioned, so a skip means the pipeline is green on tests that ` +
        `never ran. Check that \`supabase start\` succeeded earlier in the job.\n` +
        [...skippedFiles, ...skippedNames].join('\n'),
    );
  }

  // Cross-check the report against the test files actually on disk. The floor alone is a moving
  // target: it sat at 595 while the suite reached 655, so hiding a whole test file still passed
  // (finding F-010-1). This check has no such staleness — it compares against reality, and it
  // never goes red on legitimate additions the way an exact test count does.
  const expectedFiles = discoverTestFiles(options);
  if (expectedFiles.length > 0) {
    const reportedFiles = new Set(
      (report.testResults ?? []).map((file) => resolve(file.name ?? '')).filter((name) => name.length > 0),
    );
    const missing = expectedFiles.filter((file) => !reportedFiles.has(file));
    if (missing.length > 0) {
      fail(
        `[${options.label}] ${missing.length} test file(s) exist on disk but were never collected. ` +
          `A file that silently stops being collected reports green while testing nothing — the ` +
          `exact failure mode this gate exists to catch. Check for an import/setup error in:\n` +
          missing.map((file) => `  - ${file}`).join('\n'),
      );
    }
  }

  if (total < options.minTests) {
    fail(
      `[${options.label}] collected only ${total} tests, below the floor of ${options.minTests}. ` +
        `A shortfall means a suite stopped being collected — check for an import/setup error in ` +
        `a test file rather than lowering the floor. If tests were deliberately removed, lower ` +
        `--min-tests in the ci:test* script in package.json in the same commit.`,
    );
  }

  console.error(
    `[assert-test-run] ${options.label}: OK (${total} tests >= floor ${options.minTests}, 0 skipped).`,
  );
} finally {
  rmSync(reportDirectory, { recursive: true, force: true });
}
