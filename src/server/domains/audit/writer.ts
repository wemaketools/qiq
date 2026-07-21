/**
 * The audit_log writer (T-013, AC-024, V-031; M-06, P-13, NFR-02, spec §15).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Auditing/AuditWriter.cs`, with the ambient dependencies
 * removed. The .NET writer read the tenant and the actor from injected request-scoped services
 * (`ITenantContext`, `ICurrentUser`, AuditWriter.cs:26,30) — safe under a per-request DI container,
 * unsafe here, where a warm Vercel instance is shared across invocations and an ambient "current
 * tenant" is one async-context bug away from stamping the WRONG tenant onto an audit row. Tenant and
 * actor are therefore explicit fields on `AuditEntry`, supplied by the caller from its verified
 * request context.
 *
 * TRANSACTION PARTICIPATION — THE REASON THIS TAKES AN EXECUTOR
 * ============================================================
 * The reference wrote through the same `DbContext` the business change used, so
 * `SaveChangesAsync` enlisted in whatever transaction the handler had opened: the audit row and the
 * change it describes committed or rolled back together. `writeAudit` reproduces that by taking a
 * `DbExecutor` — pass the SAME `trx` the business write uses and the two are atomic. Passing the
 * root `db` from inside a transaction is a bug: the audit row would survive a rolled-back change,
 * claiming something happened that did not.
 *
 *     await withTransaction(db, async (trx) => {
 *       await trx.updateTable('leads')...
 *       await writeAudit(trx, { ... });     // same handle => same transaction
 *     });
 *
 * `audit_log` is written through the RAW executor rather than `forTenant(db, tenantId)`, even
 * though the table carries a `tenant_id`. That is deliberate and is the one legitimate unscoped
 * write in this area: `tenant_id` is NULLABLE here so that genuinely global actions (tenant
 * lifecycle, global template edits) can be recorded, and `forTenant` cannot express a null tenant.
 * The tenant on the row is whatever the caller verified, never a header value.
 */
import type { Json } from '../../lib/db/generated/supabase-types.js';
import type { DbExecutor } from '../../lib/db/index.js';
import type { AuditDetails, AuditEntry } from './types.js';

/**
 * Builds the `details` payload. `before` and `after` are ALWAYS emitted — an absent field becomes
 * an explicit `null` rather than a missing key — so every consumer can rely on
 * `details->'before'` / `details->'after'` existing (T-003's documented contract; pinned by
 * src/server/tests/integration/audit-writer.test.ts).
 */
export function buildAuditDetails(entry: AuditEntry): AuditDetails {
  return {
    ...(entry.context ?? {}),
    before: entry.before ?? null,
    after: entry.after ?? null,
  };
}

/**
 * Appends one row to `audit_log`.
 *
 * @param executor The handle to write through. Pass an open transaction to make the audit row
 *                 atomic with the change it describes.
 */
export async function writeAudit(executor: DbExecutor, entry: AuditEntry): Promise<void> {
  const details = buildAuditDetails(entry);

  await executor
    .insertInto('audit_log')
    .values({
      tenant_id: entry.tenantId,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      action: entry.action,
      actor_user_id: entry.actorUserId,
      actor_label: entry.actorLabel ?? null,
      // Set by the writer, not the caller: an audit timestamp a caller could choose is not evidence.
      acted_at: new Date().toISOString(),
      // `AuditDetails` is structurally a JSON object; the generated `Json` union differs only in
      // allowing `undefined` members, so this widens rather than reinterprets.
      details: details satisfies AuditDetails as Json,
    })
    .execute();
}

/** Action recorded when an Internal user reads a tenant they are not a member of (spec §13). */
export const CROSS_TENANT_ACCESS_ACTION = 'tenant.cross_tenant_access';
