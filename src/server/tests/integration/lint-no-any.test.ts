import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { repoRoot, runNpmScript } from './helpers/repo.js';

/**
 * The fixture is unique per run and matches eslint.config.js's `**\/*.tmp.ts` ignore, so a
 * concurrent `npm run lint` (from CI or another vitest worker) can never observe it. The
 * failing case therefore lints the fixture by explicit path with --no-ignore, which still
 * evaluates the real root config — the `no-explicit-any` gate is proven, not simulated.
 * See finding F-001-6.
 */
const fixtureRelativePath = `src/server/lib/errors/lint-any-fixture.${process.pid}-${Date.now()}.tmp.ts`;
const fixtureAbsolutePath = resolve(repoRoot, fixtureRelativePath);

afterAll(() => {
  if (existsSync(fixtureAbsolutePath)) {
    rmSync(fixtureAbsolutePath);
  }
});

describe('lint gate on the backend tree', () => {
  it('passes on the committed backend tree', () => {
    const result = runNpmScript('lint');
    expect(result.status, result.output).toBe(0);
  }, 180_000);

  it('fails at error level when `any` is introduced under src/server', () => {
    writeFileSync(
      fixtureAbsolutePath,
      'export function widen(value: unknown): any {\n  return value;\n}\n',
      'utf8',
    );

    try {
      const result = runNpmScript(`lint:path -- ${fixtureRelativePath}`);
      expect(result.status, 'lint must fail on `any` in src/server').not.toBe(0);
      expect(result.output).toContain('@typescript-eslint/no-explicit-any');
    } finally {
      rmSync(fixtureAbsolutePath);
    }

    expect(existsSync(fixtureAbsolutePath)).toBe(false);
  }, 180_000);

  it('keeps a repo-wide lint green while a transient fixture is on disk', () => {
    writeFileSync(
      fixtureAbsolutePath,
      'export function widen(value: unknown): any {\n  return value;\n}\n',
      'utf8',
    );

    try {
      const result = runNpmScript('lint');
      expect(
        result.status,
        `repo-wide lint must ignore transient *.tmp.ts fixtures (F-001-6)\n${result.output}`,
      ).toBe(0);
    } finally {
      rmSync(fixtureAbsolutePath);
    }
  }, 180_000);
});
