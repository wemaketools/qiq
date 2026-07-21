/**
 * Tenant-scoped `tenant_settings` persistence (T-020, AC-022, AC-037).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/BusinessRules/TenantSettingsStore.cs`.
 *
 * EVERY QUERY IS TENANT-PREDICATED, AND THERE IS NO DATABASE NET UNDERNEATH
 * ========================================================================
 * Postgres RLS is NOT adopted (spec Q-10, human decision 2026-07-20), so the tenant predicate
 * applied here is the ONLY thing separating one tenant's business rules from another's. A forgotten
 * predicate on THIS table is unusually damaging: `uq_tenant_settings_tenant_id` means an unscoped
 * `select ... limit 1` returns *some* tenant's row and looks entirely plausible, and an unscoped
 * UPDATE would rewrite every tenant's thresholds in one statement.
 *
 * Nothing here touches the raw executor: every function goes through `forTenant(executor, tenantId)`
 * with the branded `TenantId` the T-013 middleware verified. `business-rules.test.ts` asserts the
 * outcome per endpoint rather than trusting the construction.
 *
 * THE `numeric` COLUMN CROSSES A TYPE BOUNDARY HERE, ON PURPOSE
 * ============================================================
 * `high_value_threshold` is `numeric(18,2)`, which node-postgres returns as a STRING to avoid
 * silently rounding money through an IEEE-754 double (lib/db/generated/column-overrides.ts). The
 * .NET DTO declared it `decimal?` and System.Text.Json serialised it as a JSON NUMBER, and the SPA
 * declares `number | null` — so the wire contract is a number and the conversion has to happen
 * somewhere. It happens here, in one place, rather than being spread across handlers: `Number()` on
 * read, and the value handed back to Postgres as a string on write so the driver does not re-widen
 * it. Precision beyond a double is unreachable through this endpoint anyway, because the request
 * arrives as JSON.
 */
import { forTenant, type DbExecutor, type TenantId } from '../../lib/db/index.js';
import type { BusinessRulesDto, TenantSettings, UpdateBusinessRulesInput } from './schemas.js';

/**
 * Every column the settings reader projects: the 21 wire fields plus
 * `expire_lead_when_last_quote_expires`, which is server-side only (schemas.ts).
 */
const SETTINGS_COLUMNS = [
  'currency_code',
  'currency_symbol',
  'max_attachment_mb',
  'high_value_threshold',
  'quote_expiry_alert_days',
  'follow_up_overdue_grace_days',
  'aging_amber_days',
  'aging_red_days',
  'unassigned_lead_hours',
  'stalled_lead_days',
  'stalled_quote_days',
  'duplicate_check_days',
  'lead_ref_format',
  'quote_ref_format',
  'lead_inactivity_expiry_days',
  'pricing_approval_target_days',
  'sla_assignment_days',
  'sla_underwriting_days',
  'sla_received_to_sent_days',
  'require_pricing_approval_for_high_value',
  'manual_external_ref_enabled',
  'expire_lead_when_last_quote_expires',
] as const;

interface SettingsRow {
  readonly currency_code: string;
  readonly currency_symbol: string;
  readonly max_attachment_mb: number;
  readonly high_value_threshold: string | null;
  readonly quote_expiry_alert_days: number;
  readonly follow_up_overdue_grace_days: number;
  readonly aging_amber_days: number;
  readonly aging_red_days: number;
  readonly unassigned_lead_hours: number;
  readonly stalled_lead_days: number;
  readonly stalled_quote_days: number;
  readonly duplicate_check_days: number;
  readonly lead_ref_format: string;
  readonly quote_ref_format: string;
  readonly lead_inactivity_expiry_days: number;
  readonly pricing_approval_target_days: number;
  readonly sla_assignment_days: number;
  readonly sla_underwriting_days: number;
  readonly sla_received_to_sent_days: number;
  readonly require_pricing_approval_for_high_value: boolean;
  readonly manual_external_ref_enabled: boolean;
  readonly expire_lead_when_last_quote_expires: boolean;
}

function toTenantSettings(row: SettingsRow): TenantSettings {
  return {
    currencyCode: row.currency_code,
    currencySymbol: row.currency_symbol,
    maxAttachmentMb: Number(row.max_attachment_mb),
    highValueThreshold: row.high_value_threshold === null ? null : Number(row.high_value_threshold),
    quoteExpiryAlertDays: Number(row.quote_expiry_alert_days),
    followUpOverdueGraceDays: Number(row.follow_up_overdue_grace_days),
    agingAmberDays: Number(row.aging_amber_days),
    agingRedDays: Number(row.aging_red_days),
    unassignedLeadHours: Number(row.unassigned_lead_hours),
    stalledLeadDays: Number(row.stalled_lead_days),
    stalledQuoteDays: Number(row.stalled_quote_days),
    duplicateCheckDays: Number(row.duplicate_check_days),
    leadRefFormat: row.lead_ref_format,
    quoteRefFormat: row.quote_ref_format,
    leadInactivityExpiryDays: Number(row.lead_inactivity_expiry_days),
    pricingApprovalTargetDays: Number(row.pricing_approval_target_days),
    slaAssignmentDays: Number(row.sla_assignment_days),
    slaUnderwritingDays: Number(row.sla_underwriting_days),
    slaReceivedToSentDays: Number(row.sla_received_to_sent_days),
    requirePricingApprovalForHighValue: row.require_pricing_approval_for_high_value,
    manualExternalRefEnabled: row.manual_external_ref_enabled,
    expireLeadWhenLastQuoteExpires: row.expire_lead_when_last_quote_expires,
  };
}

/**
 * The exact `BusinessRulesDto` wire shape.
 *
 * Written as an EXPLICIT field list rather than `{ expireLeadWhenLastQuoteExpires: _, ...rest }`.
 * The spread form says "everything except the one field I remembered to exclude", so a column added
 * to `TenantSettings` by a later migration would appear on the wire automatically — an unapproved
 * contract widening (spec A-3) that nothing would flag. This form makes the wire contract an
 * allow-list: a new field has to be added here deliberately to be exposed.
 */
export function toBusinessRulesDto(settings: TenantSettings): BusinessRulesDto {
  return {
    currencyCode: settings.currencyCode,
    currencySymbol: settings.currencySymbol,
    maxAttachmentMb: settings.maxAttachmentMb,
    highValueThreshold: settings.highValueThreshold,
    quoteExpiryAlertDays: settings.quoteExpiryAlertDays,
    followUpOverdueGraceDays: settings.followUpOverdueGraceDays,
    agingAmberDays: settings.agingAmberDays,
    agingRedDays: settings.agingRedDays,
    unassignedLeadHours: settings.unassignedLeadHours,
    stalledLeadDays: settings.stalledLeadDays,
    stalledQuoteDays: settings.stalledQuoteDays,
    duplicateCheckDays: settings.duplicateCheckDays,
    leadRefFormat: settings.leadRefFormat,
    quoteRefFormat: settings.quoteRefFormat,
    leadInactivityExpiryDays: settings.leadInactivityExpiryDays,
    pricingApprovalTargetDays: settings.pricingApprovalTargetDays,
    slaAssignmentDays: settings.slaAssignmentDays,
    slaUnderwritingDays: settings.slaUnderwritingDays,
    slaReceivedToSentDays: settings.slaReceivedToSentDays,
    requirePricingApprovalForHighValue: settings.requirePricingApprovalForHighValue,
    manualExternalRefEnabled: settings.manualExternalRefEnabled,
  };
}

/**
 * `TenantSettingsStore.FindAsync`. `undefined` means this tenant has no settings row — a
 * provisioning failure, which callers translate into either a 404 (the endpoint) or a 500 (the
 * server-side reader). See service.ts for why the two differ.
 */
export async function findSettings(
  executor: DbExecutor,
  tenantId: TenantId,
): Promise<TenantSettings | undefined> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('tenant_settings')
    .select(SETTINGS_COLUMNS)
    .executeTakeFirst();

  return row === undefined ? undefined : toTenantSettings(row as SettingsRow);
}

/**
 * Applies an update and returns the stored result, so the response is what the DATABASE holds
 * rather than an echo of the request (the reference re-projected the tracked entity after
 * `SaveChangesAsync`, UpdateBusinessRulesCommandHandler.cs:81-83, which amounts to the same thing).
 *
 * `returning` also makes the update's row count observable: `executeTakeFirst()` yields `undefined`
 * when the tenant predicate matched nothing, which is the same "no settings row" signal `find`
 * gives — so a row deleted between the read and the write inside the transaction cannot be reported
 * as a successful update.
 */
export async function updateSettings(
  executor: DbExecutor,
  tenantId: TenantId,
  input: UpdateBusinessRulesInput,
  actorUserId: number,
): Promise<TenantSettings | undefined> {
  const row = await forTenant(executor, tenantId)
    .updateTable('tenant_settings')
    .set({
      currency_code: input.currencyCode,
      currency_symbol: input.currencySymbol,
      max_attachment_mb: input.maxAttachmentMb,
      // Back to a string for the driver: see the header note on the numeric boundary.
      high_value_threshold:
        input.highValueThreshold === null || input.highValueThreshold === undefined
          ? null
          : String(input.highValueThreshold),
      quote_expiry_alert_days: input.quoteExpiryAlertDays,
      follow_up_overdue_grace_days: input.followUpOverdueGraceDays,
      aging_amber_days: input.agingAmberDays,
      aging_red_days: input.agingRedDays,
      unassigned_lead_hours: input.unassignedLeadHours,
      stalled_lead_days: input.stalledLeadDays,
      stalled_quote_days: input.stalledQuoteDays,
      duplicate_check_days: input.duplicateCheckDays,
      lead_ref_format: input.leadRefFormat,
      quote_ref_format: input.quoteRefFormat,
      lead_inactivity_expiry_days: input.leadInactivityExpiryDays,
      pricing_approval_target_days: input.pricingApprovalTargetDays,
      sla_assignment_days: input.slaAssignmentDays,
      sla_underwriting_days: input.slaUnderwritingDays,
      sla_received_to_sent_days: input.slaReceivedToSentDays,
      require_pricing_approval_for_high_value: input.requirePricingApprovalForHighValue,
      manual_external_ref_enabled: input.manualExternalRefEnabled,
      updated_at: new Date().toISOString(),
      updated_by: actorUserId,
    })
    .returning(SETTINGS_COLUMNS)
    .executeTakeFirst();

  return row === undefined ? undefined : toTenantSettings(row as SettingsRow);
}
