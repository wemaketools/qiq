/**
 * Quote request schemas and wire DTOs (T-026; AC-052..AC-055, AC-096).
 *
 * Ports the FluentValidation validators under `Features/Quotes/**`, the request records declared
 * inline at `QuoteEndpoints.cs:168-187`, and the DTOs in `Features/Quotes/QuoteDto.cs`.
 *
 * THE SHAPE/RULE SPLIT IS THE REFERENCE'S, AND IT IS DELIBERATE
 * ============================================================
 * Every reference validator carries a header saying so ("Shape-level validation only; the
 * valid-until-vs-sent-date/high-value-approval rules need database lookups and live in the
 * handler"). The split survives here for a reason that outlives the port: a schema is a pure
 * function of the body, so anything requiring the quote's CURRENT status, the LEAD's dates, the
 * tenant's settings or the caller's grants cannot live in one without smuggling I/O into
 * validation. Concretely:
 *
 *   here (422 `QUOTE_VALIDATION_FAILED` with `errors[]`)   in service/operations (422, own code)
 *   ---------------------------------------------------   -------------------------------------
 *   quotedPremium > 0                                      product line / cover type are ACTIVE
 *   validUntil > preparedDate (create/update)              preparedDate >= the LEAD's dateReceived
 *   validUntil + nextFollowUpDate present (send)           validUntil > sentDate
 *   revisionNote non-empty, one of premium/terms           the high-value pricing gate
 *   lostReasonId > 0                                       reason is ACTIVE; 'other' needs a comment
 *
 * THE ERROR CODE PREFIX IS `QUOTE_`, MIRRORING `toFieldErrors`' EXISTING CONVENTION
 * ================================================================================
 * `message: 'CODE|text'` is how this codebase attaches a per-field code to a zod issue
 * (`lib/validation`'s `EXPLICIT_CODE`).
 */
import { z } from 'zod';

/** `RuleFor(x => x.<id>).GreaterThan(0)` — the quote-domain twin of the leads `positiveId`. */
export function quoteId(field: string): z.ZodType<number> {
  return z
    .number({ message: `QUOTE_REQUIRED|${field} is required.` })
    .int({ message: `QUOTE_MUST_BE_POSITIVE|${field} must be a positive id.` })
    .positive({ message: `QUOTE_MUST_BE_POSITIVE|${field} must be a positive id.` });
}

/** `yyyy-MM-dd`, matching the reference's `DateOnly` binding. */
const dateOnly = (field: string): z.ZodType<string> =>
  z
    .string({ message: `QUOTE_REQUIRED|${field} is required.` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, {
      message: `QUOTE_INVALID_DATE|${field} must be a yyyy-MM-dd date.`,
    });

/** A required free-text field: `NotEmpty()` means non-blank, not merely present. */
const requiredText = (message: string): z.ZodType<string> =>
  z
    .string({ message: `QUOTE_REQUIRED|${message}` })
    .trim()
    .min(1, { message: `QUOTE_REQUIRED|${message}` });

const optionalText = z.string().trim().nullable().optional();

/** `GreaterThan(0)` for a required money amount (`CreateQuoteValidator` :11). */
const requiredPositiveAmount = (field: string): z.ZodType<number> =>
  z
    .number({ message: `QUOTE_REQUIRED|${field} is required.` })
    .positive({ message: `QUOTE_MUST_BE_GREATER_THAN_ZERO|${field} must be greater than zero.` });

/** `GreaterThan(0).When(x => x is not null)` for an optional money amount. */
const optionalPositiveAmount = (field: string): z.ZodType<number | null | undefined> =>
  z
    .number({ message: `QUOTE_REQUIRED|${field} must be a number.` })
    .positive({ message: `QUOTE_MUST_BE_GREATER_THAN_ZERO|${field} must be greater than 0.` })
    .nullable()
    .optional();

/**
 * `CreateQuoteRequest` (:168-169) with `CreateQuoteValidator`'s rules.
 *
 * `productLineId`/`coverTypeId` are NULLABLE and that is the "default from the lead, editable"
 * signal (FR-46), not an omission. `validUntil > preparedDate` is checked here because both are in
 * the body; the reference compares against `PreparedDate ?? today`, reproduced exactly.
 */
export const createQuoteSchema = z
  .object({
    productLineId: quoteId('productLineId').nullable().optional(),
    coverTypeId: quoteId('coverTypeId').nullable().optional(),
    quotedPremium: requiredPositiveAmount('quotedPremium'),
    preparedDate: dateOnly('preparedDate').nullable().optional(),
    validUntil: dateOnly('validUntil').nullable().optional(),
    notes: optionalText,
  })
  .refine(
    (value) =>
      value.validUntil === null ||
      value.validUntil === undefined ||
      value.validUntil > (value.preparedDate ?? new Date().toISOString().slice(0, 10)),
    { message: 'QUOTE_INVALID_DATE|Valid-until must be after the prepared date.', path: ['validUntil'] },
  );

export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;

/** `UpdateDraftQuoteRequest` (:171-172) with `UpdateDraftQuoteValidator`'s rules. */
export const updateQuoteSchema = z
  .object({
    productLineId: quoteId('productLineId'),
    coverTypeId: quoteId('coverTypeId'),
    quotedPremium: requiredPositiveAmount('quotedPremium'),
    preparedDate: dateOnly('preparedDate'),
    validUntil: dateOnly('validUntil').nullable().optional(),
    notes: optionalText,
  })
  .refine(
    (value) =>
      value.validUntil === null ||
      value.validUntil === undefined ||
      value.validUntil > value.preparedDate,
    { message: 'QUOTE_INVALID_DATE|Valid-until must be after the prepared date.', path: ['validUntil'] },
  );

export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;

/**
 * `AssignQuoteRequest` (:174-176) with `AssignQuoteValidator`'s rules.
 *
 * Unlike the lead side there is NO accountable-owner invariant — `AssignQuoteCommandHandler`'s
 * header says so explicitly ("quotes have no accountable-owner requirement; that is a lead-level
 * concept"), so clearing every slot is legal here where it is not on a lead.
 */
export const assignQuoteSchema = z.object({
  assignments: z
    .array(
      z.object({
        businessAssignmentId: quoteId('businessAssignmentId'),
        userId: quoteId('userId').nullable(),
      }),
    )
    .min(1, { message: 'QUOTE_REQUIRED|At least one role assignment must be supplied.' })
    .refine(
      (assignments) =>
        new Set(assignments.map((a) => a.businessAssignmentId)).size === assignments.length,
      {
        message: 'QUOTE_DUPLICATE_ASSIGNMENT|Each assignable role may only appear once per request.',
      },
    ),
  comment: optionalText,
});

export type AssignQuoteInput = z.infer<typeof assignQuoteSchema>;

/**
 * `SendQuoteRequest` (:178) with `SendQuoteValidator`'s rules.
 *
 * `validUntil` and `nextFollowUpDate` are REQUIRED (FR-46). They are nullable at the reference's
 * command level only so an omission yields a structured 422 rather than a model-binding 400; here
 * the schema simply requires them, which is the same outcome one layer earlier.
 *
 * `validUntil > sentDate` is NOT checked here: `sentDate` defaults to TODAY when omitted, and
 * "today" is a property of the server clock at execution time, not of the body. The reference
 * checks it in the handler for exactly that reason (`SendQuoteCommandHandler.cs:72-75`).
 */
export const sendQuoteSchema = z.object({
  sentDate: dateOnly('sentDate').nullable().optional(),
  validUntil: dateOnly('validUntil'),
  nextFollowUpDate: dateOnly('nextFollowUpDate'),
});

export type SendQuoteInput = z.infer<typeof sendQuoteSchema>;

/** `ReviseQuoteRequest` (:180) with `ReviseQuoteValidator`'s rules (:5-15). */
export const reviseQuoteSchema = z
  .object({
    newQuotedPremium: optionalPositiveAmount('newQuotedPremium'),
    termsNotes: optionalText,
    revisionNote: requiredText('A revision note is required.'),
  })
  .refine(
    (value) =>
      (value.newQuotedPremium ?? null) !== null ||
      (value.termsNotes ?? '').trim() !== '',
    {
      message:
        'QUOTE_REQUIRED|At least one of a new quoted premium or terms notes must be supplied.',
      path: ['newQuotedPremium'],
    },
  );

export type ReviseQuoteInput = z.infer<typeof reviseQuoteSchema>;

/**
 * `MarkQuoteWonRequest` (:182) with `MarkQuoteWonValidator`'s rules.
 *
 * BOTH fields are OPTIONAL — measured. `boundPremium` defaults to the CURRENT VERSION's quoted
 * premium and `decisionDate` defaults to today (`MarkQuoteWonCommandHandler.cs:66-71`). AC-054's
 * "mark-won requires bound premium and decision date (422 otherwise)" describes a stricter rule
 * than the reference implements; the reference is ported and the divergence is recorded in the task
 * file rather than silently resolved either way.
 */
export const markQuoteWonSchema = z.object({
  boundPremium: optionalPositiveAmount('boundPremium'),
  decisionDate: dateOnly('decisionDate').nullable().optional(),
});

export type MarkQuoteWonInput = z.infer<typeof markQuoteWonSchema>;

/** `MarkQuoteLostRequest` (:184-185) with `MarkQuoteLostValidator`'s rules. */
export const markQuoteLostSchema = z.object({
  lostReasonId: quoteId('lostReasonId'),
  competitor: optionalText,
  competitorPremium: optionalPositiveAmount('competitorPremium'),
  lossComments: optionalText,
  /** Null means "compute the default" (true when no other open quote remains on the lead). */
  alsoCloseLead: z.boolean().nullable().optional(),
});

export type MarkQuoteLostInput = z.infer<typeof markQuoteLostSchema>;

/** `WithdrawQuoteRequest` (:187) — `WithdrawQuoteValidator` makes the note mandatory. */
export const withdrawQuoteSchema = z.object({
  withdrawalNote: requiredText('A withdrawal note is required.'),
});

export type WithdrawQuoteInput = z.infer<typeof withdrawQuoteSchema>;

/** Set current takes no body at all (`SetCurrentAsync` binds only the route id). */
export const setCurrentQuoteSchema = z.object({}).partial();

export type SetCurrentQuoteInput = z.infer<typeof setCurrentQuoteSchema>;

// ---------------------------------------------------------------------------------------------
// Wire DTOs (`Features/Quotes/QuoteDto.cs`).
// ---------------------------------------------------------------------------------------------

/** `QuoteVersionDto` (:7-13). */
export interface QuoteVersionDto {
  readonly id: number;
  readonly versionNo: number;
  readonly quotedPremium: number;
  readonly termsNotes: string | null;
  readonly revisionNote: string | null;
  readonly isCurrent: boolean;
  readonly createdAt: string;
}

/** `QuoteHistoryEntryDto` (:16-20). */
export interface QuoteHistoryEntryDto {
  readonly operation: string;
  readonly previousStatusId: number | null;
  readonly newStatusId: number | null;
  readonly actedBy: number | null;
  readonly actedAt: string;
}

/** `QuoteDto` (:30-55) — the full detail projection. */
export interface QuoteDto {
  readonly id: number;
  readonly quoteRef: string;
  readonly leadId: number;
  readonly statusId: number;
  readonly statusName: string;
  readonly statusCanonicalKey: string | null;
  readonly isCurrent: boolean;
  readonly productLineId: number;
  readonly productLineName: string;
  readonly coverTypeId: number;
  readonly coverTypeName: string;
  readonly preparedDate: string;
  readonly sentDate: string | null;
  readonly validUntil: string | null;
  readonly decisionDate: string | null;
  readonly boundPremium: number | null;
  readonly lostReasonId: number | null;
  readonly competitor: string | null;
  readonly competitorPremium: number | null;
  readonly lossComments: string | null;
  readonly withdrawalNote: string | null;
  readonly notes: string | null;
  readonly versions: readonly QuoteVersionDto[];
  readonly history: readonly QuoteHistoryEntryDto[];
  readonly availableOperations: readonly string[];
}

/**
 * `QuoteListItemDto` (:66-68) — one row of a lead's Quotes card (FR-44).
 *
 * The list route answers a BARE ARRAY of these, not a `{ items, totalCount }` envelope — measured
 * at `QuoteEndpoints.ListQuotesForLeadAsync` (:60-65), which returns `Results.Ok(result.Value)`
 * where the value is `IReadOnlyList<QuoteListItemDto>`. It is a lead-subordinate card with no
 * paging, filtering or sorting parameters, so there is no total to report. Do not "harmonise" it
 * with the paged list envelopes elsewhere in this API — that would be an unrequested wire change.
 */
export interface QuoteListItemDto {
  readonly id: number;
  readonly quoteRef: string;
  readonly statusName: string;
  readonly statusCanonicalKey: string | null;
  readonly isCurrent: boolean;
  readonly productLineName: string;
  readonly currentQuotedPremium: number;
  readonly preparedDate: string;
  readonly sentDate: string | null;
  readonly validUntil: string | null;
}
