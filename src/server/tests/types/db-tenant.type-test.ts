/**
 * COMPILE-TIME assertions for the tenant-scoping contract (T-008, AC-012, V-015).
 *
 * This file is never executed. It is checked by `npm run typecheck`, and every
 * `@ts-expect-error` below is an assertion in BOTH directions: if the error it marks ever stops
 * occurring, TypeScript reports "Unused '@ts-expect-error' directive" and the typecheck fails.
 * That is what makes "calling a tenant-scoped helper without a tenant is a compile error" a
 * verified claim rather than a comment.
 */
import type { InsertType, SelectType, UpdateType } from 'kysely';
import { createDb } from '../../lib/db/client.js';
import { forTenant, toTenantId, type TenantId } from '../../lib/db/tenant.js';
import type { Database } from '../../lib/db/types.js';

const { db } = createDb({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:6543/postgres' });
const tenantId: TenantId = toTenantId(1);

// ---------------------------------------------------------------------------------------------
// A tenant argument is mandatory.
// ---------------------------------------------------------------------------------------------

// @ts-expect-error - forTenant requires a tenant id; there is no overload without one.
forTenant(db);

// @ts-expect-error - undefined is not a tenant id.
forTenant(db, undefined);

// @ts-expect-error - a plain number is not a TenantId; it must be validated by toTenantId first.
forTenant(db, 1);

// @ts-expect-error - a string tenant id (e.g. straight off a URL parameter) is rejected.
forTenant(db, '1');

// Correct usage compiles.
forTenant(db, tenantId);

// ---------------------------------------------------------------------------------------------
// Only tenant-scoped tables can be scoped.
// ---------------------------------------------------------------------------------------------

forTenant(db, tenantId).selectFrom('leads');

// @ts-expect-error - `tenants` is the global registry and has no tenant_id column.
forTenant(db, tenantId).selectFrom('tenants');

// @ts-expect-error - partitions are not part of the schema; writes go through the parent.
forTenant(db, tenantId).selectFrom('leads_default');

// ---------------------------------------------------------------------------------------------
// insertInto owns tenant_id.
// ---------------------------------------------------------------------------------------------

forTenant(db, tenantId).insertInto('reference_items', {
  list_type: 'product_line',
  name: 'Motor',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

forTenant(db, tenantId).insertInto('reference_items', {
  list_type: 'product_line',
  name: 'Motor',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  // @ts-expect-error - the caller must not be able to choose the tenant.
  tenant_id: 999,
});

// ---------------------------------------------------------------------------------------------
// Generated column types reach the query builder.
// ---------------------------------------------------------------------------------------------

// `numeric` money columns are STRINGS at runtime (node-postgres), and `bigint` identity columns are
// numbers only because of the int8 parser installed in pool.ts. Both must be pinned in the types or
// a premium silently becomes `number` and every downstream total is quietly wrong.
//
// This pin has been defeated three times, so the form below is deliberate. Each earlier attempt
// used ASSIGNABILITY, and assignability is one-directional in ways that make a guard silently inert:
//   F-008-1  `const x: <conditional> = null as never` — `null as never` is assignable to every
//            type, so the assertion could never fail.
//   F-008-2  a hand-rolled `{ __select__: infer S }` matcher degrades to `never` if Kysely renames
//            its internal marker (a realistic upgrade), and `[never] extends [string]` is TRUE.
//   F-008-3  `[any] extends [string]` is ALSO true, while `IsNever<any>` is false — so `any`
//            satisfied both the pin and its collapse guard. A laundered `any`
//            (`ReturnType<typeof JSON.parse>`, carrying no `any` token for lint to catch) survived
//            typecheck, lint, db:types:check and all 594 tests with every money column typed `any`.
//
// `Equals` relies on conditional-type identity being INVARIANT, so it holds only for the exact same
// type: `Equals<any, string>`, `Equals<never, string>` and `Equals<string | null, string>` are all
// false. It subsumes the never-guard, rejects `any` and union widening, and needs no `any` token.
// Resolution uses Kysely's own exported `SelectType`, which falls back to `T` rather than `never`.
//
// Re-verification protocol if this file changes — all must fail typecheck:
//   (1) kyselify override branch -> `? TValue`            (money mutant)
//   (2) (1) plus resolution degraded to `never`           (marker rename)
//   (3) kyselify override branch -> a laundered `any`     (e.g. ReturnType<typeof JSON.parse>)
type Equals<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

/**
 * Money columns are pinned with EXACT per-column equality on all three sides of `ColumnType`.
 *
 * Earlier revisions used a two-arm `MoneyIsString` accepting either `string` or `string | null` for
 * any column. That accepted a nullability MISMATCH: dropping `null` from the 8 nullable columns
 * survived typecheck, lint, db:types:check and all 594 tests (finding F-008-5), after which a NULL
 * premium arrives typed `string` and `Number(null) === 0` silently zeroes it — the same money
 * corruption class as number-vs-string. Select-only pins also left the WRITE path unguarded:
 * dropping the override from `InsertType` alone was another full four-gate survivor (F-008-6), and
 * the write path is where an IEEE-754 premium would actually corrupt stored money.
 *
 * So: each column states its own exact Select/Insert/Update types. Nullability is asserted, not
 * permitted. `Equals` (invariant) rejects `any`, `never`, `unknown` and union widening on every arm.
 *
 * NOT derived from the generated `NumericColumns` list — that list would shrink alongside the very
 * defect this catches (F-008-4). A migration adding a money column requires a manual entry here.
 *
 * Re-verification protocol — every mutation below must fail `npm run typecheck`:
 *   (1) `? TValue`                                   money mutant
 *   (2) (1) + resolution degraded to `never`         marker rename
 *   (3) `? ReturnType<typeof JSON.parse>`            laundered `any`
 *   (4) `NumericColumns[TTable] & 'quoted_premium'`  partial/sampled override
 *   (5) `? unknown`
 *   (6) `? string` (drops `| null`)                  nullability mismatch
 *   (7) override dropped from `InsertType` only      write-path regression
 */
type MoneyColumn<TColumn, TSelect, TInsert, TUpdate> = Equals<SelectType<TColumn>, TSelect> extends true
  ? Equals<InsertType<TColumn>, TInsert> extends true
    ? Equals<UpdateType<TColumn>, TUpdate> extends true
      ? true
      : never
    : never
  : never;

const generatedColumnTypesArePinned: {
  readonly alertsPremiumAtRisk: MoneyColumn<
    Database['alerts']['premium_at_risk'],
    string | null,
    string | null | undefined,
    string | null | undefined
  >;
  readonly leadsCompetitorPremium: MoneyColumn<
    Database['leads']['competitor_premium'],
    string | null,
    string | null | undefined,
    string | null | undefined
  >;
  readonly leadsEstimatedPremium: MoneyColumn<
    Database['leads']['estimated_premium'],
    string | null,
    string | null | undefined,
    string | null | undefined
  >;
  readonly leadsSumInsured: MoneyColumn<
    Database['leads']['sum_insured'],
    string | null,
    string | null | undefined,
    string | null | undefined
  >;
  readonly pricingApprovalsProposedPremium: MoneyColumn<
    Database['pricing_approvals']['proposed_premium'],
    string | null,
    string | null | undefined,
    string | null | undefined
  >;
  readonly quotesBoundPremium: MoneyColumn<
    Database['quotes']['bound_premium'],
    string | null,
    string | null | undefined,
    string | null | undefined
  >;
  readonly quotesCompetitorPremium: MoneyColumn<
    Database['quotes']['competitor_premium'],
    string | null,
    string | null | undefined,
    string | null | undefined
  >;
  readonly tenantSettingsHighValueThreshold: MoneyColumn<
    Database['tenant_settings']['high_value_threshold'],
    string | null,
    string | null | undefined,
    string | null | undefined
  >;
  readonly quoteVersionsQuotedPremium: MoneyColumn<
    Database['quote_versions']['quoted_premium'],
    string,
    string,
    string | undefined
  >;
  // `bigint` identity columns are exactly `number`, and only because of the int8 parser in pool.ts.
  readonly bigintIdIsExactlyNumber: Equals<SelectType<Database['leads']['id']>, number> extends true
    ? true
    : never;
} = {
  alertsPremiumAtRisk: true,
  leadsCompetitorPremium: true,
  leadsEstimatedPremium: true,
  leadsSumInsured: true,
  pricingApprovalsProposedPremium: true,
  quotesBoundPremium: true,
  quotesCompetitorPremium: true,
  tenantSettingsHighValueThreshold: true,
  quoteVersionsQuotedPremium: true,
  bigintIdIsExactlyNumber: true,
};
void generatedColumnTypesArePinned;

void toTenantId;
