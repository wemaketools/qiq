/**
 * Permission-catalog drift guard (T-012, P-03/FR-12).
 *
 * Port of `src/api/tests/QuoteIQ.Domain.Tests/Security/PermissionCatalogDriftGuardTests.cs`. The
 * TypeScript constant and the SQL seed are two hand-editable copies of one fixed list, and a code
 * that exists in only one of them produces a route nobody can ever satisfy (or a grant nothing ever
 * checks). This pins them together; the integration suite pins the same list against the live
 * seeded table, closing the loop.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  isPermissionCode,
  PERMISSION_CODES,
  VISIBILITY_BREADTH_PERMISSIONS,
} from '../../domains/rbac/permission-catalog.js';

const SEED_PATH = fileURLToPath(new URL('../../../../supabase/seed.sql', import.meta.url));

/** The `insert into permissions (...) values (...)` block, parsed straight out of the seed file. */
function seededPermissionCodes(): string[] {
  const seed = readFileSync(SEED_PATH, 'utf8');
  const block = /insert into permissions \(code, category, description\) values(.*?)on conflict/s.exec(
    seed,
  );
  if (block === null) throw new Error(`No permissions insert found in ${SEED_PATH}`);

  return [...block[1]!.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,/g)].map((match) => match[1]!);
}

describe('permission catalog', () => {
  it('parses a non-empty catalog out of seed.sql', () => {
    // Guards the parser itself: a regex that silently matched nothing would make every
    // set-comparison below trivially pass against an empty list.
    expect(seededPermissionCodes().length).toBeGreaterThan(50);
  });

  it('matches the codes seeded by supabase/seed.sql exactly, in the same order', () => {
    expect([...PERMISSION_CODES]).toEqual(seededPermissionCodes());
  });

  it('contains the 81 codes ported from PermissionCatalog.cs', () => {
    expect(PERMISSION_CODES).toHaveLength(81);
  });

  it('has no duplicate codes', () => {
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSION_CODES.length);
  });

  it('narrows catalog codes and rejects everything else', () => {
    expect(isPermissionCode('leads.view_all')).toBe(true);
    expect(isPermissionCode('leads.view_al')).toBe(false);
    expect(isPermissionCode('')).toBe(false);
  });

  it('declares only real catalog codes as visibility-breadth permissions', () => {
    const breadth = Object.values(VISIBILITY_BREADTH_PERMISSIONS);

    expect(breadth.length).toBeGreaterThan(0);
    for (const code of breadth) {
      expect(isPermissionCode(code)).toBe(true);
    }
    // Ported from PermissionCatalog.cs:13, which names exactly these two as the breadth pair.
    expect([...breadth].sort()).toEqual(['leads.view_all', 'quotes.view_all']);
  });
});
