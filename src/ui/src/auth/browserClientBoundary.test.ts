import { describe, expect, it } from 'vitest';

/**
 * AC-017 / V-021 source assertion: the SPA's browser Supabase client is constructed exclusively
 * from `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`, in exactly one module, and reads no other
 * environment variable.
 *
 * The complementary "no server-only secret name appears in src/ui" scan deliberately lives on the
 * *backend* side (src/server/tests/integration/supabase-server-only.test.ts and
 * jobs-layering.test.ts), not here. Those guards scan every file under src/ui for the forbidden
 * variable names, so a duplicate scan living inside src/ui would have to spell those names out and
 * would therefore trip the very guards it mirrors. The built-bundle counterpart is V-003 (T-042).
 *
 * The scan uses Vite's `import.meta.glob(..., '?raw')` rather than `node:fs` deliberately: this
 * file is compiled by the SPA's own `tsconfig.app.json`, which grants no Node types, so the check
 * cannot accidentally become a licence for Node built-ins inside `src/ui`.
 */
const SOURCES = import.meta.glob<string>('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const UI_PACKAGE_JSON = import.meta.glob<string>('../../package.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const THIS_FILE = './browserClientBoundary.test.ts';

/** Every SPA source file except this spec, which necessarily names the literals it forbids. */
const scannable = Object.entries(SOURCES).filter(([path]) => path !== THIS_FILE);

describe('SPA / server credential boundary', () => {
  it('finds SPA source files to scan', () => {
    expect(scannable.length).toBeGreaterThan(50);
  });

  it('constructs the browser Supabase client from the VITE_ browser-safe variables only', () => {
    const source = SOURCES['./supabase.ts'];

    expect(source).toMatch(
      /createClient\(\s*requiredEnv\('VITE_SUPABASE_URL'\),\s*requiredEnv\('VITE_SUPABASE_ANON_KEY'\)/,
    );
  });

  it('reads no environment variable outside the two browser-safe VITE_ values', () => {
    // Scans the *code*; the allow-list is the browser-safe half of the .env.example catalog.
    const allowed = new Set(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']);
    const referenced = new Set<string>();

    for (const [, source] of scannable) {
      for (const match of source.matchAll(/['"`](VITE_[A-Z0-9_]+)['"`]/g)) {
        const name = match[1];
        if (name !== undefined) {
          referenced.add(name);
        }
      }
    }

    expect([...referenced].filter((name) => !allowed.has(name))).toEqual([]);
  });

  it('creates the Supabase client in exactly one SPA module', () => {
    const creators = scannable
      .filter(([path]) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
      .filter(([, source]) => source.includes('createClient('))
      .map(([path]) => path);

    expect(creators).toEqual(['./supabase.ts']);
  });

  it('no longer imports from the retired oidc-client-ts auth layer', () => {
    const offenders = scannable
      .filter(([, source]) => /from\s+['"]oidc-client-ts['"]/.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it('no longer declares oidc-client-ts as a SPA dependency', () => {
    const raw = UI_PACKAGE_JSON['../../package.json'];
    const parsed = JSON.parse(raw ?? '{}') as { dependencies?: Record<string, string> };

    expect(parsed.dependencies?.['oidc-client-ts']).toBeUndefined();
    expect(parsed.dependencies?.['@supabase/supabase-js']).toBeTruthy();
  });
});
