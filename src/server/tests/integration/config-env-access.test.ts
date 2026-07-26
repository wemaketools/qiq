import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  allowedFiles,
  collectSourceFiles,
  findProcessEnvViolations,
  scannedRoots,
} from '../helpers/process-env-scan.js';
import { repoRoot, runNpmScript, type CommandResult } from './helpers/repo.js';

const ENV_ACCESS = ['process', '.env'].join('');

describe('AC-010 / V-012 — direct environment access is confined to the config module', () => {
  it('finds zero direct environment reads in src/server, api and scripts', () => {
    const entries = collectSourceFiles(repoRoot, scannedRoots);

    expect(entries.length, 'scanner must actually find source files').toBeGreaterThanOrEqual(4);
    expect(entries.map((entry) => entry.path)).toContain('src/server/lib/logging/redact.ts');

    const violations = findProcessEnvViolations(entries);

    expect(
      violations,
      violations.map((v) => `${v.path}:${v.line} ${v.text}`).join('\n'),
    ).toEqual([]);
  });

  it('the config module is the file that legitimately reads the environment', () => {
    const entries = collectSourceFiles(repoRoot, scannedRoots);
    const configModule = entries.find((entry) => entry.path === 'src/server/lib/config/index.ts');

    expect(configModule, 'src/server/lib/config/index.ts must exist').toBeDefined();
    expect(configModule!.contents).toContain(ENV_ACCESS);
    expect(allowedFiles).toEqual(['src/server/lib/config/index.ts']);
  });

  it('demonstrably fails when a violation is introduced', () => {
    const probe = [
      { path: 'src/server/domains/leads/handler.ts', contents: `const x = ${ENV_ACCESS}.SUPABASE_DATABASE_URL;\n` },
    ];

    const violations = findProcessEnvViolations(probe);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.path).toBe('src/server/domains/leads/handler.ts');
    expect(violations[0]!.line).toBe(1);
  });

  it('still fails when the violation is written with unusual spacing', () => {
    const probe = [{ path: 'api/v1/index.ts', contents: `process . env ["CRON_SECRET"]` }];

    expect(findProcessEnvViolations(probe)).toHaveLength(1);
  });

  it('does not flag the allow-listed config module', () => {
    const probe = [{ path: 'src/server/lib/config/index.ts', contents: `${ENV_ACCESS}.SUPABASE_DATABASE_URL` }];

    expect(findProcessEnvViolations(probe)).toEqual([]);
  });
});

function lintSource(virtualPath: string, source: string): CommandResult {
  // A single command string keeps `shell: true` free of the Node DEP0190 escaping warning.
  const run = spawnSync(`npx --no-install eslint --stdin --stdin-filename ${virtualPath}`, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    input: source,
    timeout: 120_000,
  });
  const stdout = run.stdout ?? '';
  const stderr = run.stderr ?? '';
  return { status: run.status, stdout, stderr, output: `${stdout}\n${stderr}` };
}

describe('AC-010 / V-012 — the check is wired into the CI lint gate', () => {
  it('eslint rejects a domain file that reads the environment directly', () => {
    const result = lintSource(
      'src/server/domains/leads/lint-probe.ts',
      `export const url = ${ENV_ACCESS}.SUPABASE_DATABASE_URL;\n`,
    );

    expect(result.status, `eslint output:\n${result.output}`).toBe(1);
    expect(result.output).toMatch(/src\/server\/lib\/config/);
  });

  it('eslint allows the config module to read the environment', () => {
    const result = lintSource(
      'src/server/lib/config/index.ts',
      `export const url = ${ENV_ACCESS}.SUPABASE_DATABASE_URL;\n`,
    );

    expect(result.status, `eslint output:\n${result.output}`).toBe(0);
  });

  it('eslint also covers the test tree, which the textual scan deliberately skips', () => {
    const result = lintSource(
      'src/server/tests/unit/lint-probe.test.ts',
      `const url = ${ENV_ACCESS}.SUPABASE_DATABASE_URL;\n`,
    );

    expect(result.status, `eslint output:\n${result.output}`).toBe(1);
    expect(result.output).toMatch(/src\/server\/lib\/config/);
  });

  it('the repository currently passes the lint gate', () => {
    const result = runNpmScript('lint');

    expect(result.status, `lint output:\n${result.output}`).toBe(0);
  });
});
