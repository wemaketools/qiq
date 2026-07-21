import { describe, expect, it } from 'vitest';

import { readJsonFile, runNpmScript } from './helpers/repo.js';

/** Every root script name required by spec M-19. */
const M19_SCRIPTS = [
  'dev',
  'dev:vercel',
  'supabase:start',
  'supabase:stop',
  'supabase:reset',
  'db:migrate',
  'db:seed',
  'db:types',
  'typecheck',
  'lint',
  'test',
  'test:integration',
  'cron:list',
  'cron:run',
  'cron:run:all',
  'queue:worker',
  'queue:enqueue:test',
  'jobs:status',
] as const;

interface RootPackageJson {
  readonly engines?: { readonly node?: string };
  readonly workspaces?: readonly string[];
  readonly scripts?: Record<string, string>;
}

const pkg = readJsonFile<RootPackageJson>('package.json');
const scripts = pkg.scripts ?? {};

const STUB_MARKER = 'scripts/not-implemented.mjs';
const stubScripts = M19_SCRIPTS.filter((name) => (scripts[name] ?? '').includes(STUB_MARKER));

describe('npm workspaces root package.json', () => {
  it('declares the src/ui and e2e_tests workspaces', () => {
    expect(pkg.workspaces).toEqual(expect.arrayContaining(['src/ui', 'e2e_tests']));
  });

  it('requires Node 22 or newer', () => {
    expect(pkg.engines?.node).toBe('>=22');
  });

  it.each(M19_SCRIPTS)('defines the M-19 script %s', (name) => {
    expect(scripts[name], `script "${name}" is not defined`).toBeTruthy();
  });
});

describe('not-yet-implemented root scripts fail loudly', () => {
  // T-018 implemented `dev`, the last remaining scaffold stub, so this list is now expected to be
  // empty. The invariant protected here has always been "a stub must fail loudly", not "a stub
  // must exist" — the assertion below states the current expectation, and the loop keeps the
  // loudness check alive for any stub a future task adds.
  it('has no M-19 script left as a scaffold stub', () => {
    expect(stubScripts).toEqual([]);
  });

  it(
    'every remaining stub exits non-zero with an explicit not-implemented message',
    () => {
      for (const name of stubScripts) {
        const result = runNpmScript(name);
        expect(result.status, `"${name}" must not exit 0`).not.toBe(0);
        expect(result.output).toContain('NOT IMPLEMENTED');
        expect(result.output).toContain(name);
      }
    },
    180_000,
  );
});
