import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Deterministic job-trigger hooks for the e2e suite (T-043). Deployed, the alert/expiry sweeps run
 * on pg_cron schedules and pgmq is drained by a scheduled `/api/queue/drain` call; locally neither
 * fires on demand. These helpers invoke the SAME handler code through the repository's
 * `cron:run` / `queue:worker` npm scripts, so alert/expiry specs force job effects instead of
 * sleeping on a schedule (spec §9.5, Q-7). The scripts read `.env.local` themselves.
 */

const execFileAsync = promisify(execFile);

/** Repo root: two directories up from e2e_tests/helpers. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** npm is invoked through its shell wrapper on Windows. */
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** The registered cron sweeps (src/server/jobs/cron/registry.ts). */
export type CronJobName =
  | 'alert-evaluation'
  | 'lead-inactivity-expiry'
  | 'orphaned-upload-reaper'
  | 'quote-expiry';

async function runNpm(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(npmCommand, [...args], {
    cwd: repoRoot,
    shell: process.platform === 'win32',
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/** Runs one cron sweep now (e.g. 'quote-expiry', 'alert-evaluation'). Throws on a non-zero exit. */
export async function runCron(job: CronJobName): Promise<string> {
  return runNpm(['run', 'cron:run', '--', job]);
}

/** Drains the local pgmq queue in a single pass and exits. */
export async function drainQueue(): Promise<string> {
  return runNpm(['run', 'queue:worker', '--', '--once']);
}

/**
 * Forces the full alert pipeline to a settled state: evaluate alerts, then drain any queued work,
 * so the Alerts center reflects current conditions deterministically before a spec asserts on it.
 */
export async function evaluateAlerts(): Promise<void> {
  await runCron('alert-evaluation');
  await drainQueue();
}

/** Expires due quotes/leads and settles the queue — for the expiry/aging specs. */
export async function runExpirySweeps(): Promise<void> {
  await runCron('quote-expiry');
  await runCron('lead-inactivity-expiry');
  await drainQueue();
}
