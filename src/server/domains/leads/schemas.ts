/**
 * The lead request/response contract and the ported validation catalog (T-024, AC-042; V-055;
 * spec §14, P-06).
 *
 * Port of `CreateLeadValidator.cs`, `UpdateLeadValidator.cs`, `BulkReassignValidator.cs` and the
 * request/response records in `LeadEndpoints.cs:165-204` / `LeadDto.cs`.
 *
 * ONLY SHAPE-LEVEL RULES LIVE HERE — THAT SPLIT IS THE REFERENCE'S, AND IT IS OBSERVABLE
 * =====================================================================================
 * `CreateLeadValidator.cs:7-12` states it explicitly: reference-value existence/activeness checks
 * (party, request channel, broker, region, product line, cover-type-belongs-to-product-line, owner
 * eligibility) need database lookups and live in the service. The split is observable because the
 * two layers emit DIFFERENT CODES for the same field — a `productLineId` of `0` is
 * `LEAD_VALIDATION_FAILED` from here, while a well-formed id naming another tenant's product line
 * is `LEAD_INVALID_PRODUCT_LINE` from the service. Tests assert the code, not just the 422.
 *
 * EVERY REQUIRED FIELD USES A PLAIN REQUIRED SCHEMA, NEVER `.nullish().refine(...)`
 * ================================================================================
 * zod SHORT-CIRCUITS an optional/nullish schema on `undefined`: the `.refine` never runs, so a
 * MISSING field silently skips schema validation and is caught a layer down under the wrong code.
 * Both codes are 422, so a status-only test cannot see the difference. That defect was found and
 * fixed elsewhere in this port; it is not reintroduced here. Where a field is required, it is
 * declared required. Where the reference guards a rule with `.When(x => x.Field is not null)`, the
 * rule is attached to the VALUE via `.nullable().optional()` on an already-constrained inner
 * schema, so the constraint still applies whenever a value IS present.
 *
 * `"CODE|message"` is the lib/validation convention: the per-rule code stays next to the per-rule
 * schema and `toFieldErrors` splits it back out into the structured `errors[]` array.
 */
import { z } from 'zod';

/** `LeadPolicyTerm.All` (Domain/Leads/LeadPolicyTerm.cs:15). */
export const LEAD_POLICY_TERMS = ['m6', 'm12', 'm24', 'm36', 'other'] as const;
export type LeadPolicyTerm = (typeof LEAD_POLICY_TERMS)[number];
export const LEAD_POLICY_TERM_OTHER: LeadPolicyTerm = 'other';

/** `LeadPriority.All` (:24). */
export const LEAD_PRIORITIES = ['normal', 'high'] as const;
export type LeadPriority = (typeof LEAD_PRIORITIES)[number];
export const LEAD_PRIORITY_NORMAL: LeadPriority = 'normal';
export const LEAD_PRIORITY_HIGH: LeadPriority = 'high';

/** `LeadSource.All` (:33). */
export const LEAD_SOURCES = ['browser', 'api'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/** `LeadPricingApprovalState.None` (:43) — every lead starts here. */
export const LEAD_PRICING_APPROVAL_NONE = 'none';

/** The canonical reference item every created lead's status points at (CreateLeadCommandHandler.cs:226). */
export const NEW_STATUS_CANONICAL_KEY = 'new';

/** `ReportingCategory.Open`/`Quoted` — what "still open" means for the duplicate check. */
export const OPEN_REPORTING_CATEGORIES = ['open', 'quoted'] as const;

/** Warning codes, verbatim from `LeadDto.cs:82-83` and `CreateLeadOutcomeDto.cs:100`. */
export const DUPLICATE_PARTY_NAME_WARNING = 'DUPLICATE_PARTY_NAME';
export const DUPLICATE_EXTERNAL_REF_WARNING = 'DUPLICATE_EXTERNAL_REF';
export const DUPLICATE_LEAD_WARNING = 'DUPLICATE_LEAD';

/** `PartyContactValidation.PhonePattern()` — shared with the parties domain. */
const PHONE_PATTERN = /^[0-9+()\-.\s]{6,32}$/;

/**
 * A positive `long` id: `GreaterThan(0)` plus the integrality C#'s type system gave for free.
 *
 * EXPORTED for `domains/intake/schemas.ts` (T-030). The API intake body is the browser body with a
 * different owner/party rule (IntakeLeadCommand.cs:29-33), so it composes THESE building blocks
 * rather than restating the catalog — a second copy of `positiveId` would drift the day a code or a
 * message changes on one surface only, and both surfaces feed the same `errors[]` contract.
 */
export function positiveId(field: string): z.ZodType<number> {
  return z
    .number({ message: `LEAD_REQUIRED|${field} is required.` })
    .int({ message: `LEAD_MUST_BE_POSITIVE|${field} must be a positive id.` })
    .positive({ message: `LEAD_MUST_BE_POSITIVE|${field} must be a positive id.` });
}

/**
 * `GreaterThan(0).When(x => x is not null)` for a money amount — `SumInsured`/`EstimatedPremium`
 * (CreateLeadValidator.cs:51-52). The constraint lives on the INNER schema, so it applies whenever
 * a value is present and is simply skipped when the field is null/omitted.
 */
function optionalPositiveAmount(field: string): z.ZodType<number | null | undefined> {
  return z
    .number({ message: `LEAD_REQUIRED|${field} must be a number.` })
    .positive({ message: `LEAD_MUST_BE_GREATER_THAN_ZERO|${field} must be greater than 0.` })
    .nullable()
    .optional();
}

/** `yyyy-MM-dd`, matching the reference's `DateOnly` binding. */
const dateOnly = (field: string): z.ZodType<string> =>
  z
    .string({ message: `LEAD_REQUIRED|${field} is required.` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: `LEAD_INVALID_DATE|${field} must be a yyyy-MM-dd date.` });

/** Today in UTC, as `yyyy-MM-dd` — `DateOnly.FromDateTime(DateTime.UtcNow)` (CreateLeadValidator.cs:31). */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * `InlinePartyInput` (LeadEndpoints.cs:165-167) with `CreateLeadValidator.cs:21-28`'s rules.
 *
 * String comparison is correct for `yyyy-MM-dd` — it is lexicographically ordered — and avoids the
 * timezone drift a `Date` round-trip would introduce.
 */
export const inlinePartySchema = z.object({
  name: z
    .string({ message: 'LEAD_REQUIRED|Party name is required.' })
    .trim()
    .min(1, { message: 'LEAD_REQUIRED|Party name is required.' })
    .max(200, { message: 'LEAD_MAX_LENGTH|Party name must be 200 characters or fewer.' }),
  partyTypeId: positiveId('Party type'),
  segmentId: positiveId('Segment').nullable().optional(),
  industryId: positiveId('Industry').nullable().optional(),
  regionId: positiveId('Region').nullable().optional(),
  isStrategic: z.boolean().nullable().optional(),
  contactName: z.string().trim().max(200).nullable().optional(),
  contactEmail: z
    .string()
    .trim()
    .email({ message: 'LEAD_INVALID_EMAIL|Contact email must be a valid email address.' })
    .nullable()
    .optional(),
  contactPhone: z
    .string()
    .trim()
    .regex(PHONE_PATTERN, { message: 'LEAD_INVALID_PHONE|Contact phone is not a valid phone number.' })
    .nullable()
    .optional(),
});

export type InlinePartyInput = z.infer<typeof inlinePartySchema>;

/**
 * The fields Create and Update share (`CreateLeadRequest`/`UpdateLeadRequest`, :169-202).
 *
 * EXPORTED for the API intake body (T-030), which reuses this shape verbatim — see `positiveId`.
 */
export const leadWriteShape = {
  isExistingClient: z.boolean({ message: 'LEAD_REQUIRED|Existing-client is required.' }),
  dateReceived: dateOnly('Date received'),
  requestChannelId: positiveId('Request channel'),
  brokerId: positiveId('Broker').nullable().optional(),
  regionId: positiveId('Region'),
  externalRef: z.string().trim().max(100).nullable().optional(),
  productLineId: positiveId('Product line'),
  coverTypeId: positiveId('Cover type'),
  sumInsured: optionalPositiveAmount('Sum insured'),
  estimatedPremium: optionalPositiveAmount('Estimated premium'),
  policyTerm: z.enum(LEAD_POLICY_TERMS, {
    message: 'LEAD_POLICY_TERM_INVALID|Policy term is not recognized.',
  }),
  policyTermOther: z.string().trim().max(200).nullable().optional(),
};

/**
 * The policy-term free-text pair (CreateLeadValidator.cs:55-62) — BOTH directions.
 *
 * The reference does not merely require the text on `other`; it also REJECTS text supplied with any
 * other term (:59-62). Dropping the second half would let a lead carry contradictory data (a 12-
 * month term with an "18 months" free-text note) that no screen would ever show, so both halves are
 * ported and both have their own test.
 */
export function checkPolicyTerm(
  value: { policyTerm: string; policyTermOther?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  const other = value.policyTermOther ?? '';

  if (value.policyTerm === LEAD_POLICY_TERM_OTHER && other.trim() === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['policyTermOther'],
      message: "LEAD_POLICY_TERM_OTHER_REQUIRED|Policy term 'other' requires a free-text description.",
    });
    return;
  }

  if (value.policyTerm !== LEAD_POLICY_TERM_OTHER && other.trim() !== '') {
    ctx.addIssue({
      code: 'custom',
      path: ['policyTermOther'],
      message:
        "LEAD_POLICY_TERM_OTHER_NOT_ALLOWED|Policy term other-text is only allowed when policy term is 'other'.",
    });
  }
}

/** The future-date rule, shared by create and update (CreateLeadValidator.cs:30-32). */
export function checkDateReceived(value: { dateReceived: string }, ctx: z.RefinementCtx): void {
  if (value.dateReceived > todayUtc()) {
    ctx.addIssue({
      code: 'custom',
      path: ['dateReceived'],
      message: 'LEAD_DATE_RECEIVED_FUTURE|Date received cannot be in the future.',
    });
  }
}

/**
 * `POST /api/v1/leads` (CreateLeadRequest, :169-187).
 *
 * `dateReceived` is compared against TODAY at parse time (:30-32). A lead received today is legal —
 * the reference uses `LessThanOrEqualTo`, so the boundary is inclusive, and that boundary has its
 * own test because an off-by-one here would reject every same-day intake.
 */
export const createLeadSchema = z
  .object({
    ...leadWriteShape,
    partyId: positiveId('Party').nullable().optional(),
    inlineParty: inlinePartySchema.nullable().optional(),
    ownerUserId: positiveId('Owner'),
    priority: z
      .enum(LEAD_PRIORITIES, { message: 'LEAD_PRIORITY_INVALID|Priority is not recognized.' })
      .nullable()
      .optional(),
    intakeNotes: z.string().trim().max(4000).nullable().optional(),
    createAnyway: z.boolean().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    // `(x.PartyId is not null) != (x.InlineParty is not null)` (:17-19) — EXCLUSIVE OR. Both
    // supplied is as invalid as neither, and the reference's single message covers both.
    const hasParty = value.partyId !== null && value.partyId !== undefined;
    const hasInline = value.inlineParty !== null && value.inlineParty !== undefined;
    if (hasParty === hasInline) {
      ctx.addIssue({
        code: 'custom',
        path: ['partyId'],
        message: 'LEAD_PARTY_CHOICE_INVALID|Exactly one of partyId or inlineParty must be supplied.',
      });
    }
  })
  .superRefine(checkDateReceived)
  .superRefine(checkPolicyTerm);

export type CreateLeadInput = z.infer<typeof createLeadSchema>;

/**
 * `PUT /api/v1/leads/{id}` (UpdateLeadRequest, :189-202).
 *
 * MEASURED DIFFERENCES FROM CREATE, ALL THREE OF THEM DELIBERATE:
 *   - `priority` is REQUIRED and non-null here (`string Priority`, :201) but optional on create
 *     (`string? Priority`, :185), because create DERIVES it from the high-value threshold when it
 *     is absent and edit never re-derives.
 *   - there is no `ownerUserId`: ownership changes go through Assign/bulk-reassign, not through edit.
 *   - there is no party choice: a lead cannot be moved to a different client by editing it.
 */
export const updateLeadSchema = z
  .object({
    ...leadWriteShape,
    priority: z.enum(LEAD_PRIORITIES, {
      message: 'LEAD_PRIORITY_INVALID|Priority is not recognized.',
    }),
  })
  .superRefine(checkDateReceived)
  .superRefine(checkPolicyTerm);

export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

/** `BulkReassignValidator.cs:10-12`. The note is mandatory (Q-12) and is the headline rule (AC-046). */
export const bulkReassignSchema = z.object({
  leadIds: z
    .array(positiveId('Lead'), { message: 'LEAD_REQUIRED|At least one lead must be selected.' })
    .min(1, { message: 'LEAD_REQUIRED|At least one lead must be selected.' }),
  newOwnerUserId: positiveId('New owner'),
  note: z
    .string({ message: 'LEAD_REQUIRED|An audit note is required for bulk reassign.' })
    .trim()
    .min(1, { message: 'LEAD_REQUIRED|An audit note is required for bulk reassign.' })
    .max(2000),
});

export type BulkReassignInput = z.infer<typeof bulkReassignSchema>;

/**
 * `GET /api/v1/leads` query string (LeadEndpoints.cs:43-56).
 *
 * `status` is a COMMA-SEPARATED list of status ids (:48-52) — not a single value and not a status
 * name. Everything is coerced from strings because it arrives from a query string.
 */
const optionalIdParam = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .refine((value) => value > 0)
  .optional();

export const listLeadsQuerySchema = z.object({
  status: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map(Number),
    )
    .refine((ids) => ids.every((id) => Number.isSafeInteger(id) && id > 0), {
      message: 'LEAD_STATUS_FILTER_INVALID|Status filter must be a comma-separated list of status ids.',
    })
    .optional(),
  ownerUserId: optionalIdParam,
  brokerId: optionalIdParam,
  productLineId: optionalIdParam,
  regionId: optionalIdParam,
  requestChannelId: optionalIdParam,
  dateReceivedFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateReceivedTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // `bool? myLeads` — only the literal `true` enables it, matching ASP.NET's bool binding.
  myLeads: z
    .string()
    .transform((value) => value.toLowerCase() === 'true')
    .optional(),
  search: z.string().optional(),
  sort: z.string().optional(),
  page: z.string().regex(/^\d+$/).transform(Number).optional(),
  pageSize: z.string().regex(/^\d+$/).transform(Number).optional(),
});

export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;

/**
 * Sortable Leads-list columns (`LeadStore.ListAsync`'s switch, :232-262).
 *
 * `flags` is ABSENT BY DESIGN (:230-231): it is derived per row rather than stored, so there is no
 * column to order by. Narrowing the caller's string to this union is what keeps it out of SQL.
 */
export const LEAD_SORT_FIELDS = [
  'lead_ref',
  'party',
  'broker',
  'product',
  'premium',
  'status',
  'date_received',
  'owner',
  'next_follow_up',
] as const;

export type LeadSortField = (typeof LEAD_SORT_FIELDS)[number];

/** `LeadAssigneeDto` (LeadDto.cs:9). */
export interface LeadAssigneeDto {
  readonly userId: number;
  readonly firstName: string;
  readonly lastName: string;
}

/** `LeadNoteDto` (:12). */
export interface LeadNoteDto {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

/** `LeadDto` (:25-55). */
export interface LeadDto {
  readonly id: number;
  readonly leadRef: string;
  readonly externalRef: string | null;
  readonly partyId: number;
  readonly partyName: string;
  readonly requestChannelId: number;
  readonly brokerId: number | null;
  readonly brokerName: string | null;
  readonly regionId: number;
  readonly productLineId: number;
  readonly productLineName: string;
  readonly coverTypeId: number;
  readonly coverTypeName: string;
  readonly sumInsured: number | null;
  readonly estimatedPremium: number | null;
  readonly policyTerm: string;
  readonly policyTermOther: string | null;
  readonly priority: string;
  readonly isExistingClient: boolean;
  readonly statusId: number;
  readonly statusName: string;
  readonly statusCanonicalKey: string | null;
  readonly dateReceived: string;
  readonly source: string;
  readonly owner: LeadAssigneeDto | null;
  readonly notes: readonly LeadNoteDto[];
  readonly availableOperations: readonly string[];
  readonly lastFollowUpDate: string | null;
  readonly nextFollowUpDate: string | null;
  readonly isNextFollowUpOverdue: boolean;
}

/**
 * `LeadListItemDto` (:110-126) — the Leads list row AND the party detail Leads card.
 *
 * CANONICAL HERE, re-exported by `parties/schemas.ts`, which needed the same shape one task earlier
 * for its leads card. One definition, so the two surfaces cannot drift apart.
 */
export interface LeadListItemDto {
  readonly id: number;
  readonly leadRef: string;
  readonly partyId: number;
  readonly partyName: string;
  readonly brokerId: number | null;
  readonly brokerName: string | null;
  readonly productLineName: string;
  readonly coverTypeName: string;
  readonly premium: number | null;
  readonly statusName: string;
  readonly priority: string;
  readonly dateReceived: string;
  readonly ageDays: number;
  readonly owner: LeadAssigneeDto | null;
  readonly nextFollowUpDate: string | null;
  readonly flags: readonly string[];
}

/**
 * `LeadListDto` (:166) — note `totalCount`, NOT `total`.
 *
 * `totalCount` is universal across the reference DTOs (`BrokerListDto`, `PartyListDto`,
 * `DrillResultDto`) and is what the SPA reads. Emitting `total` would break every consumer.
 */
export interface LeadListDto {
  readonly items: readonly LeadListItemDto[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
}

/** `LeadWarningDto` (:80) — a non-blocking annotation on a successful mutation. */
export interface LeadWarningDto {
  readonly code: string;
  readonly details: Record<string, unknown>;
}

/** `LeadDuplicateMatchDto` (:87). */
export interface LeadDuplicateMatchDto {
  readonly leadId: number;
  readonly leadRef: string;
  readonly status: string;
  readonly dateReceived: string;
}

/**
 * `CreateLeadOutcomeDto` (:98-107). Either the created lead plus warnings, or — when an open
 * duplicate is found and the caller did not pass `createAnyway` — a confirm-gated envelope naming
 * the duplicates with `lead: null` and NOTHING PERSISTED.
 */
export interface CreateLeadOutcomeDto {
  readonly lead: LeadDto | null;
  readonly warnings: readonly LeadWarningDto[];
  readonly requiresConfirmation: boolean;
}

/** The Update response: the refreshed lead plus any non-blocking warnings. */
export interface UpdateLeadOutcomeDto {
  readonly lead: LeadDto;
  readonly warnings: readonly LeadWarningDto[];
}

/** `BulkReassignResultDto` (BulkReassignCommand.cs:16). */
export interface BulkReassignResultDto {
  readonly reassignedCount: number;
}
