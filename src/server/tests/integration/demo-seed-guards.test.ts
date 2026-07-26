import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { repoRoot } from './helpers/repo.js';

/**
 * The demo seed's refusals, driven through the REAL CLI.
 *
 * Two guards, both about damage that cannot be undone:
 *
 *   1. production is refused OUTRIGHT, before --env is even consulted. The dataset is two invented
 *      tenants, sixteen invented users and several hundred invented leads and quotes, and nothing
 *      removes them again. A flag that merely has to be typed is a weaker guarantee than a refusal.
 *   2. any non-local target without DEMO_SEED_PASSWORD is refused, because the seed re-asserts
 *      every persona's password on each run — falling back to the committed one would undo a
 *      rotation and re-publish a password that lives in this repository.
 *
 * Driven as a subprocess rather than by importing the module, because the guards' whole value is
 * that the COMMAND refuses: an operator's protection is the exit code, not an internal branch.
 * Neither case reaches a database, so both run without touching one.
 */

const tsxCli = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
let tempDir: string | null = null;
let fileSeq = 0;

function envFile(values: Readonly<Record<string, string>>): string {
  tempDir ??= mkdtempSync(join(tmpdir(), 'quoteiq-demo-guard-'));
  const path = join(tempDir, `env-${String(fileSeq++)}.env`);
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  writeFileSync(path, `${body}\n`, 'utf8');
  return path;
}

/**
 * `.env.local` supplies the rest of the catalog so config validation is never what fails; the
 * overrides file is layered after it and wins. Same shape the baseline seed's guard tests use.
 */
function runSeed(
  overrides: Readonly<Record<string, string>>,
  args: readonly string[] = [],
): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    [
      tsxCli,
      '--env-file-if-exists=.env.local',
      `--env-file=${envFile(overrides)}`,
      'scripts/db/seed-demo.ts',
      ...args,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 180_000, windowsHide: true },
  );
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

describe('demo seed guards', () => {
  afterAll(() => {
    if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves the tsx entrypoint this suite drives', () => {
    expect(existsSync(tsxCli)).toBe(true);
  });

  it('refuses production even when it is named explicitly', () => {
    const result = runSeed(
      { APP_ENV: 'production', DEMO_SEED_PASSWORD: 'a-configured-demo-password' },
      ['--env=production'],
    );

    expect(result.status, `expected a refusal, got:\n${result.output}`).not.toBe(0);
    expect(result.output).toMatch(/will not run against production/i);
  });

  it('refuses production before the --env gate, so the message names the real reason', () => {
    // Without --env the older guard would also refuse, but for the wrong reason ("name the
    // environment"). The production refusal must win, or an operator learns to just add the flag.
    const result = runSeed({ APP_ENV: 'production', DEMO_SEED_PASSWORD: 'a-configured-demo-password' });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/will not run against production/i);
    expect(result.output).not.toMatch(/re-run it naming that environment/i);
  });

  it('points at db:admin:create instead, which is how production is bootstrapped', () => {
    const result = runSeed({ APP_ENV: 'production', DEMO_SEED_PASSWORD: 'a-configured-demo-password' });

    expect(result.output).toContain('db:admin:create');
  });

  it('refuses a non-local target when DEMO_SEED_PASSWORD is unset', () => {
    // No DEMO_SEED_PASSWORD in the overrides, and .env.local does not define one either.
    const result = runSeed({ APP_ENV: 'dev' }, ['--env=dev']);

    expect(result.status, `expected a refusal, got:\n${result.output}`).not.toBe(0);
    expect(result.output).toContain('DEMO_SEED_PASSWORD');
  });

  it('explains WHY the password is required, not merely that it is missing', () => {
    const result = runSeed({ APP_ENV: 'dev' }, ['--env=dev']);

    expect(result.output).toMatch(/every run|re-assert|re-publish/i);
  });

  it('still refuses a non-local target that was not named, password or not', () => {
    const result = runSeed({ APP_ENV: 'dev', DEMO_SEED_PASSWORD: 'a-configured-demo-password' });

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/refus/i);
  });
});
