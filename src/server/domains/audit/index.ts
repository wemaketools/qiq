/**
 * Audit trail (T-013, AC-024, P-13, spec §15).
 *
 * Every privileged or business-critical operation writes here, through the caller's transaction.
 * See writer.ts for why the tenant and actor are explicit parameters rather than ambient services.
 */
export { CROSS_TENANT_ACCESS_ACTION, buildAuditDetails, writeAudit } from './writer.js';
export type { AuditDetails, AuditEntry, JsonValue } from './types.js';
