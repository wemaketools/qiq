/**
 * Tenant business-rules behaviour (T-020, AC-022, AC-024, AC-037).
 *
 * Ports `GetBusinessRulesQueryHandler` and `UpdateBusinessRulesCommandHandler`
 * (src/api/QuoteIQ.Application/Features/BusinessRules/), plus the read seam
 * `ITenantSettingsProvider` that later features consume.
 *
 * THE UPDATE AND ITS AUDIT ROW SHARE ONE TRANSACTION (AC-024, V-031)
 * =================================================================
 * The reference wrote its audit row through a separate `IAuditWriter` call AFTER
 * `SaveChangesAsync` (UpdateBusinessRulesCommandHandler.cs:79-89), so a crash in between changed a
 * tenant's SLA targets and thresholds with no record of who did it. Here the read, the write and
 * the audit row are one transaction — strictly stronger, and the pattern every other domain in this
 * port uses (tenants/service.ts, reference-data/service.ts).
 *
 * The audit payload is the WHOLE before and after DTO, not a diff, matching the reference
 * (`new { Before = before, After = after }`, :85). Twenty-one interacting thresholds are only
 * interpretable together — knowing `agingRedDays` moved to 15 tells you nothing without the amber
 * value it must stay above.
 */
import { writeAudit } from '../audit/index.js';
import { InternalError } from '../../lib/errors/index.js';
import { withTransaction, type DbClient, type DbExecutor, type TenantId } from '../../lib/db/index.js';
import { businessRulesNotFoundError } from './errors.js';
import { findSettings, toBusinessRulesDto, updateSettings } from './repository.js';
import type { BusinessRulesDto, TenantSettings, UpdateBusinessRulesInput } from './schemas.js';

export interface BusinessRulesDeps {
  readonly db: DbClient;
}

/** Who performed the action and in which verified tenant, for audit rows and the `updated_by` stamp. */
export interface BusinessRulesActor {
  readonly userId: number;
  readonly tenantId: TenantId;
  readonly correlationId?: string;
}

export const TENANT_SETTINGS_UPDATED_ACTION = 'tenant_settings.updated';

/** The reference's audit `entity_type` (UpdateBusinessRulesCommandHandler.cs:82). */
export const TENANT_SETTINGS_ENTITY_TYPE = 'tenant_settings';

function auditContext(actor: BusinessRulesActor): { context?: { correlationId: string } } {
  return actor.correlationId === undefined ? {} : { context: { correlationId: actor.correlationId } };
}

/**
 * The DTO as a jsonb-safe record. Every field is already a string/number/boolean/null, so this is a
 * widening rather than a projection — the audit row carries ALL 21 fields on both halves, which is
 * what makes the before/after pair independently interpretable.
 */
function auditPayload(dto: BusinessRulesDto): Record<string, string | number | boolean | null> {
  return { ...dto };
}

/** `GetBusinessRulesQueryHandler` (:13-22). */
export async function getBusinessRules(
  deps: BusinessRulesDeps,
  actor: BusinessRulesActor,
): Promise<BusinessRulesDto> {
  const settings = await findSettings(deps.db, actor.tenantId);
  if (settings === undefined) throw businessRulesNotFoundError();
  return toBusinessRulesDto(settings);
}

/**
 * `UpdateBusinessRulesCommandHandler` (:38-91).
 *
 * Validation has already happened at the route boundary (schemas.ts), matching the reference's
 * validator-then-handler order: an invalid payload never reaches the read, so a 422 leaves no
 * transaction open and no audit row behind.
 */
export async function updateBusinessRules(
  deps: BusinessRulesDeps,
  input: UpdateBusinessRulesInput,
  actor: BusinessRulesActor,
): Promise<BusinessRulesDto> {
  return await withTransaction(deps.db, async (trx) => {
    const existing = await findSettings(trx, actor.tenantId);
    if (existing === undefined) throw businessRulesNotFoundError();

    const updated = await updateSettings(trx, actor.tenantId, input, actor.userId);
    // Unreachable in practice — the row was just read inside this transaction — but treated as the
    // same provisioning failure rather than being asserted away, so a concurrent delete cannot be
    // reported as a successful update.
    if (updated === undefined) throw businessRulesNotFoundError();

    const before = toBusinessRulesDto(existing);
    const after = toBusinessRulesDto(updated);

    await writeAudit(trx, {
      entityType: TENANT_SETTINGS_ENTITY_TYPE,
      // The reference used the TENANT ID as the entity id (:83) — there is exactly one settings row
      // per tenant, so the tenant IS the settings row's identity. Preserved so an audit reader
      // finds it the same way.
      entityId: String(actor.tenantId),
      action: TENANT_SETTINGS_UPDATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: auditPayload(before),
      after: auditPayload(after),
      ...auditContext(actor),
    });

    return after;
  });
}

/**
 * The typed settings reader for SERVER-SIDE consumers (T-020 implementation_details; port of
 * `ITenantSettingsProvider`). Alert jobs, workflow legality checks, the duplicate-lead window and
 * dashboard currency formatting all read a tenant's rules through this rather than each
 * re-projecting `tenant_settings` or reaching into this domain's HTTP handlers.
 *
 * IT THROWS ON A MISSING ROW; IT DOES NOT FALL BACK TO DEFAULTS
 * ============================================================
 * `TenantSettingsProvider.GetAsync` (TenantSettingsProvider.cs:24-25) throws for the same reason,
 * and it is the safer of the two options by some distance. A defaults fallback would mean a tenant
 * whose provisioning silently failed still passes every read — running on DIFFERENT thresholds from
 * the ones its Settings screen shows (which 404s), with alerts firing on the wrong windows and
 * high-value classification disabled. That is a data-correctness bug wearing a working system's
 * clothes. `DEFAULT_TENANT_SETTINGS` (schemas.ts) documents the provisioning baseline and is
 * asserted against a real row by the suite; it is deliberately NOT wired in as a fallback here.
 *
 * NO CROSS-REQUEST CACHING (N-02). The reference cached per REQUEST SCOPE, which has no equivalent
 * under Vercel: a module-level cache would outlive the request on a warm function instance and
 * serve one tenant's thresholds to the next. Each call reads the row.
 */
export async function getTenantSettings(
  executor: DbExecutor,
  tenantId: TenantId,
): Promise<TenantSettings> {
  const settings = await findSettings(executor, tenantId);
  if (settings === undefined) {
    throw new InternalError(
      `Tenant ${String(tenantId)} has no tenant_settings row; every tenant must be provisioned one ` +
        'at creation (spec §11.2).',
    );
  }
  return settings;
}
