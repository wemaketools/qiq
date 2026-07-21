/**
 * Data-access layer (T-008, A-8, M-09, M-12, N-03).
 *
 * Kysely — a type-safe SQL query builder, explicitly NOT an ORM (Q-1) — over node-postgres,
 * configured for Supabase's Supavisor transaction pooler. Read pool.ts before changing anything
 * about connections; read tenant.ts before writing a query against a tenant-scoped table.
 *
 * Migrations are plain SQL managed by the Supabase CLI. Kysely's migrator is not used.
 *
 * THE PER-REQUEST PATTERN FOR HANDLERS
 * ====================================
 *     const db = getDb();                        // process-wide pool, holds no request state
 *     const scope = forTenant(db, tenantId);     // request-scoped, tenant-narrowed handle
 *     await scope.selectFrom('leads')...
 *
 * The CLIENT is deliberately process-wide and the TENANT SCOPE is deliberately per-request. Those
 * are different lifetimes on purpose: a pool must outlive a request (rebuilding it per request
 * would open a connection per request and defeat the pooler), while tenant context must NOT outlive
 * one (that is how a request ends up reading another tenant's data). Nothing request-scoped is ever
 * stored on the client — there is no `db.setTenant()` and there must never be one.
 *
 * For multi-statement work: `withTransaction(db, fn)`, or `scope.transaction(fn)` to keep the
 * tenant narrowing inside the transaction.
 */
export { closeDb, createDb, createDirectDb, getDb, type DbHandle } from './client.js';
export { MAX_POOLED_CONNECTIONS, directPoolConfig, parseInt8, poolerPoolConfig } from './pool.js';
export { withTransaction } from './transactions.js';
export {
  TENANT_SCOPED_TABLES,
  forTenant,
  isTenantId,
  tenantPredicate,
  toTenantId,
  type TenantId,
  type TenantInsertable,
  type TenantScope,
  type TenantScopedTable,
} from './tenant.js';
export type { Database, DbClient, DbExecutor, DbTransaction, TableName } from './types.js';
