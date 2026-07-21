/**
 * Tenant business-rules request/response contract (T-020, AC-037; spec §12 Settings, FR-11).
 *
 * Ported field-for-field from `BusinessRulesDto`
 * (src/api/QuoteIQ.Application/Features/BusinessRules/BusinessRulesDto.cs:7-27) and the write shape
 * `UpdateBusinessRulesRequest` (src/api/QuoteIQ.Api/Endpoints/BusinessRuleEndpoints.cs:96-117),
 * which are the SAME 21 fields in the same order. The SPA already declares exactly this shape
 * (`src/ui/src/features/settings/settingsApi.ts:101-123` `FullBusinessRulesDto`), and PUTs the DTO
 * it last read straight back — so read and write must stay identical field sets.
 *
 * ONE COLUMN IS DELIBERATELY NOT ON THE WIRE
 * ==========================================
 * `tenant_settings.expire_lead_when_last_quote_expires` exists in the schema
 * (20260718002200_tenant_settings.sql:81) and in the .NET entity, but `BusinessRulesDto` does not
 * project it and `UpdateBusinessRulesRequest` does not accept it — the reference exposes no way to
 * read or change it through this endpoint. Preserved: adding it would be a contract change (A-3),
 * and the rule has no consumer until the quote-expiry job (T-030+). The settings READER below
 * exposes it to server-side consumers, which is how the reference reached it too
 * (`ITenantSettingsProvider` hands out the whole entity).
 *
 * UNKNOWN KEYS ARE STRIPPED, NOT REJECTED — AND THAT IS THE OPPOSITE OF reference-data/schemas.ts
 * ==============================================================================================
 * The reference binds this body to a positional C# record, which ignores unrecognized JSON
 * properties, so a client sending an extra key gets a 200. Reference data rejects unknown keys
 * because there an unknown key was a smuggling vector for a guarded column (`canonicalKey`,
 * `isTerminal`). Here there is nothing to smuggle: the update writes exactly the 21 named columns
 * and nothing else, so a stray key can only be ignored. Rejecting it would 422 a request the
 * reference answered 200.
 *
 * MISSING FIELDS ARE REQUIRED FAILURES, WHICH MATCHES THE REFERENCE'S OUTCOME IF NOT ITS PATH
 * ==========================================================================================
 * In .NET an omitted `int` binds to `0` and an omitted `string` to `null`, so an incomplete PUT
 * failed the `GreaterThan(0)` / `NotEmpty()` rules and produced a 422 anyway. Requiring the fields
 * outright yields the same 422 with a clearer per-field message, and — critically — prevents the
 * one case where the reference's binding was actively dangerous: `followUpOverdueGraceDays` allows
 * zero, so an omitted field would have silently RESET a tenant's configured grace period to 0.
 */
import { z } from 'zod';

import { validateReferenceFormat } from './reference-format.js';

/**
 * Every day/hour/MB threshold is an `integer` column
 * (20260718002200_tenant_settings.sql:47-64). The reference validated only the lower bound, so a
 * value above the int32 ceiling passed validation and then blew up in the database as an
 * unmapped 500. The ceiling is enforced here as a 422 instead.
 *
 * TARGET-ONLY HARDENING, DELIBERATELY NARROW: it changes the response only for inputs the
 * reference could never actually store (it crashed on them), so no request that succeeded against
 * the reference fails here. Flagged in the task file.
 */
const INT32_MAX = 2_147_483_647;

/** FluentValidation `GreaterThan(0)`, plus the storable-value ceiling above. */
function positiveInteger(label: string): z.ZodType<number> {
  return z
    .number({ message: `NotNullValidator|'${label}' must not be empty.` })
    .int({ message: `GreaterThanValidator|'${label}' must be greater than '0'.` })
    .min(1, { message: `GreaterThanValidator|'${label}' must be greater than '0'.` })
    .max(INT32_MAX, {
      message: `InclusiveBetweenValidator|'${label}' must be ${String(INT32_MAX)} or fewer.`,
    });
}

/** `RuleFor(x => x.FollowUpOverdueGraceDays).GreaterThanOrEqualTo(0)` — zero is legal here alone. */
function nonNegativeInteger(label: string): z.ZodType<number> {
  return z
    .number({ message: `NotNullValidator|'${label}' must not be empty.` })
    .int({
      message: `GreaterThanOrEqualValidator|'${label}' must be greater than or equal to '0'.`,
    })
    .min(0, {
      message: `GreaterThanOrEqualValidator|'${label}' must be greater than or equal to '0'.`,
    })
    .max(INT32_MAX, {
      message: `InclusiveBetweenValidator|'${label}' must be ${String(INT32_MAX)} or fewer.`,
    });
}

/**
 * `RuleFor(x => x.LeadRefFormat).NotEmpty().Custom(ValidateReferenceFormat)`
 * (UpdateBusinessRulesValidator.cs:52-53).
 *
 * The custom rule's message is `ReferenceFormatTemplate.Validate`'s own error string, verbatim, so
 * a tenant admin who typed `{BRANCH}` is told which token was not understood.
 */
function referenceFormat(label: string): z.ZodType<string> {
  return z
    .string({ message: `NotNullValidator|'${label}' must not be empty.` })
    .superRefine((value, ctx) => {
      if (value.trim().length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: `NotEmptyValidator|'${label}' must not be empty.`,
        });
        return;
      }
      const result = validateReferenceFormat(value);
      if (!result.valid) {
        ctx.addIssue({ code: 'custom', message: `PredicateValidator|${result.error}` });
      }
    });
}

/**
 * `RuleFor(x => x.CurrencyCode).NotEmpty().Matches("^[A-Z]{3}$")` with the reference's custom
 * message (UpdateBusinessRulesValidator.cs:22-25).
 *
 * SHAPE ONLY, NOT THE ISO-4217 REGISTRY — the reference says so in its own doc comment (:8-10) and
 * calls it an explicit scope boundary. `ZZZ` is accepted by both. Preserved rather than tightened:
 * validating against a currency list would reject codes an existing tenant may already have stored.
 */
const currencyCode = z
  .string({ message: "NotNullValidator|'Currency Code' must not be empty." })
  .superRefine((value, ctx) => {
    if (value.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: "NotEmptyValidator|'Currency Code' must not be empty.",
      });
    }
    if (!/^[A-Z]{3}$/.test(value)) {
      ctx.addIssue({
        code: 'custom',
        message:
          "RegularExpressionValidator|Currency code must be a 3-letter ISO-4217-shaped code (e.g. 'BWP').",
      });
    }
  });

/** `RuleFor(x => x.CurrencySymbol).NotEmpty().MaximumLength(10)` (:27). */
const currencySymbol = z
  .string({ message: "NotNullValidator|'Currency Symbol' must not be empty." })
  .max(10, {
    message: "MaximumLengthValidator|'Currency Symbol' must be 10 characters or fewer.",
  })
  .refine((value) => value.length > 0, {
    message: "NotEmptyValidator|'Currency Symbol' must not be empty.",
  });

/**
 * `RuleFor(x => x.HighValueThreshold).GreaterThan(0).When(x => x.HighValueThreshold is not null)`
 * (:30).
 *
 * NULL IS MEANINGFUL AND MUST STAY DISTINCT FROM ZERO (the column is nullable for this reason,
 * 20260718002200_tenant_settings.sql:44-45): a tenant with no configured threshold has NO
 * high-value classification, whereas a threshold of 0 would classify every lead as high-value.
 * `.nullish()` accepts an omitted field as null, matching `decimal?` binding.
 */
const highValueThreshold = z
  .number({ message: "NotNullValidator|'High Value Threshold' must be a number." })
  .positive({ message: "GreaterThanValidator|'High Value Threshold' must be greater than '0'." })
  .nullish();

export const updateBusinessRulesSchema = z
  .object({
    currencyCode,
    currencySymbol,
    maxAttachmentMb: positiveInteger('Max Attachment Mb'),
    highValueThreshold,
    quoteExpiryAlertDays: positiveInteger('Quote Expiry Alert Days'),
    followUpOverdueGraceDays: nonNegativeInteger('Follow Up Overdue Grace Days'),
    agingAmberDays: positiveInteger('Aging Amber Days'),
    agingRedDays: positiveInteger('Aging Red Days'),
    unassignedLeadHours: positiveInteger('Unassigned Lead Hours'),
    stalledLeadDays: positiveInteger('Stalled Lead Days'),
    stalledQuoteDays: positiveInteger('Stalled Quote Days'),
    duplicateCheckDays: positiveInteger('Duplicate Check Days'),
    leadRefFormat: referenceFormat('Lead Ref Format'),
    quoteRefFormat: referenceFormat('Quote Ref Format'),
    leadInactivityExpiryDays: positiveInteger('Lead Inactivity Expiry Days'),
    pricingApprovalTargetDays: positiveInteger('Pricing Approval Target Days'),
    slaAssignmentDays: positiveInteger('Sla Assignment Days'),
    slaUnderwritingDays: positiveInteger('Sla Underwriting Days'),
    slaReceivedToSentDays: positiveInteger('Sla Received To Sent Days'),
    requirePricingApprovalForHighValue: z.boolean({
      message: "NotNullValidator|'Require Pricing Approval For High Value' must be a boolean.",
    }),
    manualExternalRefEnabled: z.boolean({
      message: "NotNullValidator|'Manual External Ref Enabled' must be a boolean.",
    }),
  })
  .superRefine((value, ctx) => {
    // `RuleFor(x => x.AgingRedDays).GreaterThan(x => x.AgingAmberDays)` (:36-38). A SEPARATE rule
    // from the `GreaterThan(0)` above, so an amber/red pair of `0`/`0` reports BOTH failures, as
    // the reference does. Amber >= red would make the amber bucket unreachable — every aging lead
    // would jump straight to red and the amber SLA signal would silently vanish.
    if (value.agingRedDays <= value.agingAmberDays) {
      ctx.addIssue({
        code: 'custom',
        path: ['agingRedDays'],
        message:
          'GreaterThanValidator|Aging red threshold must be greater than the aging amber threshold.',
      });
    }
  });

export type UpdateBusinessRulesInput = z.infer<typeof updateBusinessRulesSchema>;

/** `BusinessRulesDto` — the wire projection, identical field set to the write shape. */
export interface BusinessRulesDto {
  readonly currencyCode: string;
  readonly currencySymbol: string;
  readonly maxAttachmentMb: number;
  readonly highValueThreshold: number | null;
  readonly quoteExpiryAlertDays: number;
  readonly followUpOverdueGraceDays: number;
  readonly agingAmberDays: number;
  readonly agingRedDays: number;
  readonly unassignedLeadHours: number;
  readonly stalledLeadDays: number;
  readonly stalledQuoteDays: number;
  readonly duplicateCheckDays: number;
  readonly leadRefFormat: string;
  readonly quoteRefFormat: string;
  readonly leadInactivityExpiryDays: number;
  readonly pricingApprovalTargetDays: number;
  readonly slaAssignmentDays: number;
  readonly slaUnderwritingDays: number;
  readonly slaReceivedToSentDays: number;
  readonly requirePricingApprovalForHighValue: boolean;
  readonly manualExternalRefEnabled: boolean;
}

/** Field order of `BusinessRulesDto`, for the contract test that pins the wire shape. */
export const BUSINESS_RULES_DTO_FIELDS = [
  'currencyCode',
  'currencySymbol',
  'maxAttachmentMb',
  'highValueThreshold',
  'quoteExpiryAlertDays',
  'followUpOverdueGraceDays',
  'agingAmberDays',
  'agingRedDays',
  'unassignedLeadHours',
  'stalledLeadDays',
  'stalledQuoteDays',
  'duplicateCheckDays',
  'leadRefFormat',
  'quoteRefFormat',
  'leadInactivityExpiryDays',
  'pricingApprovalTargetDays',
  'slaAssignmentDays',
  'slaUnderwritingDays',
  'slaReceivedToSentDays',
  'requirePricingApprovalForHighValue',
  'manualExternalRefEnabled',
] as const satisfies readonly (keyof BusinessRulesDto)[];

/**
 * The full server-side settings view — the DTO plus the one column the wire contract omits.
 *
 * This is what `getTenantSettings` hands downstream consumers (alert jobs, workflow legality,
 * dashboard currency). It is a SEPARATE type from `BusinessRulesDto` on purpose: a consumer that
 * needs `expireLeadWhenLastQuoteExpires` must not be able to get it by widening the wire DTO, which
 * is a contract.
 */
export interface TenantSettings extends BusinessRulesDto {
  readonly expireLeadWhenLastQuoteExpires: boolean;
}

/**
 * The column defaults every freshly provisioned tenant starts from
 * (20260718002200_tenant_settings.sql:40-83), which the migration documents as being kept 1:1 with
 * the .NET `TenantSettings` property initialisers.
 *
 * Exported so it can be ASSERTED against a real provisioned row rather than trusted: the settings
 * reader does NOT fall back to these (see service.ts — a missing row is a provisioning alarm, not a
 * defaults case). They exist as the documented baseline and as the fixture a test can diff against.
 */
export const DEFAULT_TENANT_SETTINGS: TenantSettings = {
  currencyCode: 'BWP',
  currencySymbol: 'BWP',
  maxAttachmentMb: 10,
  highValueThreshold: null,
  quoteExpiryAlertDays: 7,
  followUpOverdueGraceDays: 0,
  agingAmberDays: 8,
  agingRedDays: 15,
  unassignedLeadHours: 24,
  stalledLeadDays: 7,
  stalledQuoteDays: 7,
  duplicateCheckDays: 30,
  leadRefFormat: 'L-{YYYY}-{SEQ:4}',
  quoteRefFormat: 'Q-{YYYY}-{SEQ:4}',
  leadInactivityExpiryDays: 60,
  pricingApprovalTargetDays: 3,
  slaAssignmentDays: 1,
  slaUnderwritingDays: 3,
  slaReceivedToSentDays: 5,
  requirePricingApprovalForHighValue: false,
  manualExternalRefEnabled: false,
  expireLeadWhenLastQuoteExpires: false,
};
