/**
 * Frozen reference inventory for the baseline seed (T-006, AC-009, P-03/P-04).
 *
 * The baseline seed (`supabase/seed.sql`) is a hand-authored port of the original .NET provisioning
 * sources. A test that asserted "the database contains what seed.sql says" would be circular: it
 * would pass just as happily with a mistyped permission code or a wrong `canonical_key`, and those
 * failures are SILENT — a wrong permission code fails authorization open/closed at runtime, and a
 * wrong canonical key silently corrupts every conversion metric (AC-073/AC-074) rather than erroring.
 *
 * DURING THE MIGRATION this inventory was DERIVED at test time from the original C# sources
 * (`PermissionCatalog.cs` and `DefaultReferenceData.cs`) so that the seed could not drift from the
 * behavioural source of truth. At cutover (T-044) the legacy `src/api` tree was removed, so that
 * live derivation is no longer possible. The exact inventory it produced was captured, verbatim,
 * into `fixtures/baseline-seed-reference.json` and is now the frozen expectation. `db:validate`
 * guarantees the SCHEMA; this fixture guarantees the seed CONTENT — the two independent derivations
 * (this fixture vs `supabase/seed.sql` and the live database) are still compared key-for-key, so a
 * drifted or mistyped seed row still fails loudly. The frozen JSON is a checked-in snapshot, so any
 * intentional change to the baseline is a reviewable edit to both the seed and this fixture.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { repoRoot } from '../integration/helpers/repo.js';

const fixturePath = resolve(repoRoot, 'src/server/tests/fixtures/baseline-seed-reference.json');

export interface PermissionReference {
  readonly code: string;
  readonly category: string;
  readonly description: string;
}

export interface DefaultReferenceItemReference {
  readonly listType: string;
  readonly name: string;
  readonly displayOrder: number;
  readonly isBrokerChannel: boolean | null;
  readonly reportingCategory: string | null;
  readonly canonicalKey: string | null;
  readonly isTerminal: boolean;
}

interface Fixture {
  readonly permissions: readonly PermissionReference[];
  readonly items: readonly DefaultReferenceItemReference[];
}

function loadFixture(): Fixture {
  const raw = readFileSync(fixturePath, 'utf8');
  const parsed = JSON.parse(raw) as Fixture;
  if (!Array.isArray(parsed.permissions) || parsed.permissions.length === 0) {
    throw new Error(`Baseline seed fixture has no permissions: ${fixturePath}`);
  }
  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new Error(`Baseline seed fixture has no reference items: ${fixturePath}`);
  }
  return parsed;
}

export function readBaselinePermissionCatalog(): PermissionReference[] {
  return [...loadFixture().permissions];
}

export function readBaselineReferenceItems(): DefaultReferenceItemReference[] {
  return [...loadFixture().items];
}

/** Stable sort key for comparing two inventories row-by-row. */
export function referenceItemKey(item: { listType: string; name: string }): string {
  return `${item.listType}\u0000${item.name}`;
}
