/**
 * Tenant-scoped query helpers (T-008, AC-012, V-015, spec §13).
 *
 * THE PROBLEM THESE SOLVE
 * =======================
 * Almost every table in this schema is tenant-scoped, and a single forgotten
 * `where tenant_id = ?` is a cross-tenant data leak — the most serious defect this product can
 * ship. There is no ambient/global "current tenant" anywhere in this codebase on purpose: an
 * implicit tenant is one async-context bug away from being the WRONG tenant, and it makes the
 * dangerous code look identical to the safe code.
 *
 * Instead the tenant is an explicit, typed argument:
 *
 *     const scope = forTenant(db, tenantId);
 *     await scope.selectFrom('leads').selectAll().execute();   // tenant predicate already applied
 *
 * Four properties make omission hard:
 *
 *   1. `forTenant` cannot be called without a tenant id — a compile-time error (V-015 asserts this
 *      with @ts-expect-error in src/server/tests/types/db-tenant.type-test.ts).
 *   2. `TenantId` is a BRANDED number. A raw `number` — a path parameter, a JSON body field, a
 *      different entity's id — will not type-check. It must go through `toTenantId`, which
 *      validates, so "where did this tenant id come from" has exactly one answer.
 *   3. The predicate is applied by the helper, not by the caller, and is table-qualified, so it
 *      survives joins and cannot be dropped by rewriting the caller's own `where`.
 *   4. `insertInto` INJECTS `tenant_id` and its type forbids the caller from supplying one, so a
 *      row cannot be written into the wrong tenant even by an explicitly hostile request body.
 *
 * HOW A CALLER CAN STILL BYPASS THIS — read before relying on it
 * =============================================================
 * These helpers are a guard rail, not a sandbox. A caller who reaches for the raw `DbClient` and
 * writes `db.selectFrom('leads')` gets an unscoped query and nothing here will stop them. That is
 * intentional — cross-tenant Internal/global endpoints legitimately need it — but it means the
 * guarantee is "hard to do by accident", not "impossible". The remaining layers are:
 *   - RLS as defense-in-depth (T-014, Q-10), which does not depend on the caller getting it right;
 *   - per-endpoint tenant-isolation integration tests (N-01), which test the outcome, not the code;
 *   - review: an unscoped query on a tenant-scoped table is greppable precisely because the safe
 *     path looks different.
 */
import {
  sql,
  type DeleteQueryBuilder,
  type DeleteResult,
  type Expression,
  type InsertQueryBuilder,
  type InsertResult,
  type Insertable,
  type SelectQueryBuilder,
  type SqlBool,
  type UpdateQueryBuilder,
  type UpdateResult,
} from 'kysely';

import { TENANT_SCOPED_TABLE_NAMES } from './generated/tenant-scoped-tables.js';
import type { Database, DbClient, DbExecutor } from './types.js';

declare const tenantIdBrand: unique symbol;

/**
 * A validated tenant id. Branded so that an arbitrary `number` cannot be passed where a tenant is
 * expected; construct one with `toTenantId`.
 */
export type TenantId = number & { readonly [tenantIdBrand]: 'TenantId' };

/** Tables carrying a `tenant_id` column, generated from information_schema. */
export const TENANT_SCOPED_TABLES = TENANT_SCOPED_TABLE_NAMES;

export type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];

/**
 * Cross-check: the generated list must agree with the generated schema. If a migration adds a
 * tenant-scoped table and only one of the two generated artifacts is refreshed, this fails to
 * compile rather than leaving a table quietly unprotected.
 */
type TablesWithTenantColumn = {
  [K in keyof Database]: 'tenant_id' extends keyof Database[K] ? K : never;
}[keyof Database];

/**
 * Both directions are checked, and both are wrapped in a tuple: a bare
 * `A extends B ? true : never` DISTRIBUTES over the union, so a single non-conforming member is
 * absorbed into `true | never === true` and the assertion silently passes. `[A] extends [B]`
 * compares the unions as a whole, which is what makes this fail when a table is missing.
 *
 * The assertion is a VALUE, not a type alias, because an unreferenced type alias is never
 * instantiated and therefore never checked.
 */
const tenantTableCoverage: {
  readonly everyListedTableExistsInTheSchema: [TenantScopedTable] extends [TablesWithTenantColumn]
    ? true
    : never;
  readonly everySchemaTableIsListed: [TablesWithTenantColumn] extends [TenantScopedTable]
    ? true
    : never;
} = { everyListedTableExistsInTheSchema: true, everySchemaTableIsListed: true };
void tenantTableCoverage;

/** True for values that are usable as a tenant id: a positive, safe integer. */
export function isTenantId(value: unknown): value is TenantId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Validates and brands a tenant id. Throws on anything else — including `undefined`, which is the
 * shape a missing tenant context arrives in when an untyped boundary hands one over.
 */
export function toTenantId(value: number): TenantId {
  if (!isTenantId(value)) {
    throw new TypeError(
      `Invalid tenant id: ${JSON.stringify(value)}. A tenant id must be a positive integer.`,
    );
  }
  return value;
}

/**
 * The tenant predicate as a standalone expression, for queries too complex for the scope helpers
 * (multi-table joins, CTEs). Table-qualified and parameterised.
 */
export function tenantPredicate<T extends TenantScopedTable>(
  table: T,
  tenantId: TenantId,
): Expression<SqlBool> {
  return sql<SqlBool>`${sql.ref(`${table}.tenant_id`)} = ${toTenantId(tenantId)}`;
}

/** Insert values for a tenant-scoped table, minus the tenant the scope supplies. */
export type TenantInsertable<T extends TenantScopedTable> = Omit<
  Insertable<Database[T]>,
  'tenant_id'
>;

/** Query-builder types the scope hands back, pre-filtered to the tenant. */
type SelectFor<T extends TenantScopedTable> = SelectQueryBuilder<Database, T, object>;
type UpdateFor<T extends TenantScopedTable> = UpdateQueryBuilder<Database, T, T, UpdateResult>;
type DeleteFor<T extends TenantScopedTable> = DeleteQueryBuilder<Database, T, DeleteResult>;
type InsertFor<T extends TenantScopedTable> = InsertQueryBuilder<Database, T, InsertResult>;

export interface TenantScope {
  /** The tenant every query from this scope is restricted to. */
  readonly tenantId: TenantId;

  selectFrom<T extends TenantScopedTable>(table: T): SelectFor<T>;

  updateTable<T extends TenantScopedTable>(table: T): UpdateFor<T>;

  deleteFrom<T extends TenantScopedTable>(table: T): DeleteFor<T>;

  /** `tenant_id` is supplied by the scope and cannot be overridden by the caller. */
  insertInto<T extends TenantScopedTable>(table: T, values: TenantInsertable<T>): InsertFor<T>;

  /**
   * Runs `fn` in a transaction, scoped to the same tenant. When this scope is already inside a
   * transaction the callback JOINS it rather than opening a nested one, so composing two scoped
   * operations cannot produce a half-committed result.
   */
  transaction<R>(fn: (trx: TenantScope) => Promise<R>): Promise<R>;
}

/**
 * Kysely's `where` is a set of overloads, and over a GENERIC table name TypeScript cannot pick one
 * ("no signatures are compatible with each other"). Every builder nonetheless accepts a bare
 * boolean expression, which is the only form used here. Narrowing to that one signature keeps the
 * unavoidable cast in a single named place instead of scattering `as never` through the helpers.
 */
interface AcceptsBooleanFilter {
  where(expression: Expression<SqlBool>): unknown;
}

function filtered<T extends TenantScopedTable>(
  builder: unknown,
  table: T,
  tenantId: TenantId,
): never {
  return (builder as AcceptsBooleanFilter).where(tenantPredicate(table, tenantId)) as never;
}

function scopeFor(executor: DbExecutor, tenantId: TenantId): TenantScope {
  const scope: TenantScope = {
    tenantId,

    selectFrom: (table) => filtered(executor.selectFrom(table), table, tenantId),

    updateTable: (table) => filtered(executor.updateTable(table), table, tenantId),

    deleteFrom: (table) => filtered(executor.deleteFrom(table), table, tenantId),

    insertInto: (table, values) =>
      executor
        .insertInto(table)
        // tenant_id LAST so a caller-supplied one (only reachable through an `as` cast) is
        // overwritten rather than honoured.
        .values({ ...values, tenant_id: tenantId } as never) as never,

    transaction: async (fn) => {
      if (executor.isTransaction) return await fn(scope);
      return await (executor as DbClient)
        .transaction()
        .execute(async (trx) => await fn(scopeFor(trx, tenantId)));
    },
  };

  return scope;
}

/**
 * Restricts every query built from the returned scope to one tenant.
 * The tenant id is required; there is no overload without it.
 */
export function forTenant(db: DbExecutor, tenantId: TenantId): TenantScope {
  return scopeFor(db, toTenantId(tenantId));
}
