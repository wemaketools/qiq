import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Seed hooks for the e2e suite (T-043): drive the repository's seed npm scripts so the suite runs
 * against the known demo dataset (T-041). The demo seed is idempotent and converges to a
 * byte-identical dataset, so re-running before a suite is safe.
 */

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function runNpm(args: readonly string[], timeoutMs: number): Promise<void> {
  await execFileAsync(npmCommand, [...args], {
    cwd: repoRoot,
    shell: process.platform === 'win32',
    env: process.env,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
}

/** Drops + recreates the DB, replays all migrations, and runs the baseline seed. Slow (minutes). */
export async function resetDatabase(): Promise<void> {
  await runNpm(['run', 'supabase:reset'], 10 * 60 * 1000);
}

/** Layers the full idempotent demo dataset (personas, tenants, leads, quotes, alert fixtures). */
export async function seedDemo(): Promise<void> {
  await runNpm(['run', 'db:seed:demo'], 5 * 60 * 1000);
}
