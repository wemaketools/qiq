/**
 * The service-role key and the Auth Admin API are server-only (T-011, AC-017, V-021).
 *
 * This is the source-level half of the guarantee; V-003 (T-018/T-042) scans the emitted SPA
 * bundle. Both are needed: a bundle scan cannot run before the SPA imports anything, and a source
 * scan cannot see what a bundler inlines.
 *
 * Deliberately static and network-free, so it runs on every machine and in CI regardless of
 * whether the Supabase stack is up.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from './helpers/repo.js';

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.turbo', 'build']);
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs'];

interface SourceFile {
  readonly path: string;
  readonly contents: string;
}

function collect(root: string): SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (absolute: string): void => {
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      return;
    }

    if (stats.isDirectory()) {
      for (const name of readdirSync(absolute)) {
        if (SKIPPED_DIRECTORIES.has(name)) continue;
        walk(resolve(absolute, name));
      }
      return;
    }

    if (!SCANNED_EXTENSIONS.some((extension) => absolute.endsWith(extension))) return;
    files.push({
      path: relative(repoRoot, absolute).split('\\').join('/'),
      contents: readFileSync(absolute, 'utf8'),
    });
  };

  walk(resolve(repoRoot, root));
  return files;
}

function matchesIn(files: readonly SourceFile[], pattern: RegExp): string[] {
  return files
    .filter((file) => new RegExp(pattern.source, pattern.flags).test(file.contents))
    .map((file) => file.path);
}

const uiFiles = collect('src/ui/src');
const serverFiles = collect('src/server');

describe('SPA source cannot reach server-only Supabase code (V-021)', () => {
  it('scans a non-empty SPA source tree (guards against a scanner that matches nothing)', () => {
    // Five separate false-greens in this repo have come from scans with empty inputs.
    expect(uiFiles.length).toBeGreaterThan(0);
    expect(serverFiles.length).toBeGreaterThan(0);
  });

  it('contains no import of any src/server module', () => {
    const importsServer = uiFiles.filter((file) => {
      const specifiers = [...file.contents.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      const dynamic = [...file.contents.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
        (m) => m[1],
      );
      return [...specifiers, ...dynamic].some(
        (specifier) =>
          specifier !== undefined &&
          (specifier.includes('src/server') || /(^|\/)\.\.\/server\//.test(specifier)),
      );
    });

    expect(importsServer.map((file) => file.path)).toEqual([]);
  });

  it('never names the service-role key or constructs an Auth Admin client', () => {
    expect(matchesIn(uiFiles, /SUPABASE_SERVICE_ROLE_KEY/)).toEqual([]);
    expect(matchesIn(uiFiles, /service_role/)).toEqual([]);
    expect(matchesIn(uiFiles, /auth\s*\.\s*admin\b/)).toEqual([]);
    expect(matchesIn(uiFiles, /getAdminClient/)).toEqual([]);
  });

  it('builds any browser Supabase client from VITE_ variables only', () => {
    // T-018 introduces the SPA client; until then this asserts the absence, and the moment a
    // client appears it must satisfy the VITE-only rule rather than silently skipping.
    const clientModules = matchesIn(uiFiles, /createClient\s*\(/);

    for (const path of clientModules) {
      const contents = uiFiles.find((file) => file.path === path)?.contents ?? '';
      expect(contents, `${path} must use VITE_SUPABASE_URL`).toMatch(/VITE_SUPABASE_URL/);
      expect(contents, `${path} must use VITE_SUPABASE_ANON_KEY`).toMatch(/VITE_SUPABASE_ANON_KEY/);
    }
  });
});

describe('server-side service-role usage is confined to the config module (V-021, V-012)', () => {
  it('names SUPABASE_SERVICE_ROLE_KEY only in the config schema', () => {
    const namingFiles = matchesIn(serverFiles, /SUPABASE_SERVICE_ROLE_KEY/).filter(
      (path) => !path.startsWith('src/server/tests/'),
    );

    expect(namingFiles).toEqual(['src/server/lib/config/schema.ts']);
  });

  it('constructs the Auth Admin client in exactly one module, from typed config', () => {
    // The tests tree is excluded because this file necessarily contains the pattern itself.
    const adminFactories = matchesIn(serverFiles, /export function getAdminClient/).filter(
      (path) => !path.startsWith('src/server/tests/'),
    );
    expect(adminFactories).toEqual(['src/server/lib/supabase/clients.ts']);

    const clients =
      serverFiles.find((file) => file.path === 'src/server/lib/supabase/clients.ts')?.contents ?? '';
    expect(clients).toContain('config.supabase.serviceRoleKey');
    // No direct environment access (the config module is the only sanctioned reader, AC-010).
    expect(clients).not.toMatch(/process\s*\.\s*env/);
  });

  it('keeps the verification client on the anon key, never the service-role key', () => {
    const clients =
      serverFiles.find((file) => file.path === 'src/server/lib/supabase/clients.ts')?.contents ?? '';
    const verificationBlock = clients.slice(
      clients.indexOf('export function getVerificationClient'),
      clients.indexOf('export function getAdminClient'),
    );

    expect(verificationBlock).toContain('config.supabase.anonKey');
    expect(verificationBlock).not.toContain('serviceRoleKey');
  });
});
