import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { optionalEnvVars, requiredEnvVars } from '../../lib/config/index.js';

/**
 * Drift guard for T-042. The environment catalog must stay one-to-one across four surfaces:
 *   1. the typed config schema (the only server reader of process.env),
 *   2. .env.example (deployed placeholders),
 *   3. .env.local.example (local values),
 *   4. docs/environment-variables.md (the human catalog).
 *
 * A variable the config module reads but a file omits, or a file documenting an active variable
 * the schema never reads, is exactly the doc-vs-reality drift this task exists to prevent.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function read(relative: string): string {
  return readFileSync(resolve(repoRoot, relative), 'utf8');
}

/** Browser-safe variables read by the SPA (not the server config module) but still cataloged. */
const browserVars = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'] as const;

/** Every variable that must appear across all catalog surfaces. */
const serverVars = [...requiredEnvVars, ...optionalEnvVars] as const;
const allCatalogVars = [...serverVars, ...browserVars];

/** Keys the schema actually reads, plus browser vars — the only keys an example file may assign. */
const knownKeys = new Set<string>(allCatalogVars);

const catalogFiles = ['.env.example', '.env.local.example', 'docs/environment-variables.md'];

/** Non-comment `KEY=value` assignment keys in an env example file. */
function activeAssignmentKeys(contents: string): string[] {
  const keys: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed === '' || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    keys.push(trimmed.slice(0, trimmed.indexOf('=')).trim());
  }
  return keys;
}

describe('environment catalog stays in sync with the config schema', () => {
  it.each(catalogFiles)('%s documents every variable the config module reads', (relative) => {
    const contents = read(relative);
    for (const variable of allCatalogVars) {
      expect(contents.includes(variable), `${relative} is missing ${variable}`).toBe(true);
    }
  });

  it.each(['.env.example', '.env.local.example'])(
    '%s only assigns variables the config schema knows about',
    (relative) => {
      for (const key of activeAssignmentKeys(read(relative))) {
        expect(knownKeys.has(key), `${relative} assigns unknown variable ${key}`).toBe(true);
      }
    },
  );

  it('lists every required variable as an active assignment in both example files', () => {
    for (const relative of ['.env.example', '.env.local.example']) {
      const keys = new Set(activeAssignmentKeys(read(relative)));
      for (const variable of requiredEnvVars) {
        expect(keys.has(variable), `${relative} does not assign required ${variable}`).toBe(true);
      }
    }
  });

  it('keeps deliberately-absent variables out of the catalog as active variables', () => {
    for (const relative of ['.env.example', '.env.local.example']) {
      const keys = new Set(activeAssignmentKeys(read(relative)));
      expect(keys.has('SUPABASE_JWT_SECRET')).toBe(false);
      expect(keys.has('ERROR_TRACKING_DSN')).toBe(false);
    }
  });
});
