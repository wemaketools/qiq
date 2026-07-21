import { describe, expect, it } from 'vitest';

import { readJsonFile } from './helpers/repo.js';

interface TsConfig {
  readonly extends?: string;
  readonly compilerOptions?: Record<string, unknown>;
  readonly include?: readonly string[];
}

const base = readJsonFile<TsConfig>('tsconfig.json');
const server = readJsonFile<TsConfig>('tsconfig.server.json');

function option(name: string): unknown {
  return server.compilerOptions?.[name] ?? base.compilerOptions?.[name];
}

describe('backend TypeScript configuration', () => {
  it('enables strict mode for the server tree', () => {
    expect(option('strict')).toBe(true);
  });

  it('enables noUncheckedIndexedAccess', () => {
    expect(option('noUncheckedIndexedAccess')).toBe(true);
  });

  it('does not emit JavaScript from the typecheck configuration', () => {
    expect(option('noEmit')).toBe(true);
  });

  it('covers the server, function entrypoint, and scripts trees', () => {
    const include = server.include ?? [];
    expect(include).toEqual(
      expect.arrayContaining(['api/**/*.ts', 'src/server/**/*.ts', 'scripts/**/*.ts']),
    );
  });

  it('does not include the SPA tree, which keeps its own tsconfig', () => {
    for (const entry of server.include ?? []) {
      expect(entry.startsWith('src/ui')).toBe(false);
    }
  });
});
