/**
 * Parties request/response contracts (T-023, AC-041; spec FR-26..FR-28, §12).
 *
 * Ported field-for-field from the reference DTOs so the existing SPA keeps working unchanged
 * (`src/ui/src/features/parties/partiesApi.ts` already declares exactly these shapes):
 *   `PartyDto(Id, Name, PartyTypeId, SegmentId, IndustryId, RegionId, IsStrategic, ContactName,
 *             ContactEmail, ContactPhone, LastActivityAt, OpenLeadsCount, TotalLeadsCount)`
 *     — src/api/QuoteIQ.Application/Features/Parties/PartyDto.cs:12-25
 *   `PartyWarningMatchDto(Id, Name)`            (:45)
 *   `PartyWarningDto(Code, Matches)`            (:55)
 *   `PartyMutationResultDto(Party, Warnings)`   (:64)
 *   `PartyListDto(Items, TotalCount, Page, PageSize)` (:67)
 *   `CreatePartyRequest`/`UpdatePartyRequest`   — PartyEndpoints.cs:96-102 (identical shapes)
 *
 * THE LIST ENVELOPE FIELD IS `totalCount`, NOT `total` — REPORTED DEVIATION FROM THE TASK FILE
 * ===========================================================================================
 * T-023's implementation_details describe the envelope as `{items,page,pageSize,total}`. Both the
 * reference (`PartyListDto`, :67) and the SPA that consumes it (`partiesApi.ts` `PartyListDto`)
 * say `totalCount`. Shipping `total` would break the existing grid's paging for no stated benefit,
 * so the measured contract wins and the discrepancy is flagged in the task file.
 *
 * CREATE AND UPDATE SHARE ONE SCHEMA — A PORTED SYMMETRY, VERIFIED NOT ASSUMED
 * ===========================================================================
 * `CreatePartyValidator` (:13-22) and `UpdatePartyValidator` are rule-for-rule identical, and the
 * two request records (:96-102) are field-for-field identical. Unlike reference-data — where the
 * two validators genuinely diverge and the schemas must stay apart — collapsing them here changes
 * no observable code or message.
 */
import { z } from 'zod';

/**
 * `PartyContactValidation.PhonePattern()`
 * (src/api/QuoteIQ.Application/Features/Parties/PartyContactValidation.cs:16), verbatim.
 *
 * Anchored, and deliberately lenient: digits plus the common separators/prefix characters, 7-20
 * characters. The reference's own doc comment (:5-13) records this as a documented product judgment
 * call because no spec-defined phone format exists — so it is ported EXACTLY rather than "improved",
 * since tightening it would 422 numbers the current SPA accepts today.
 */
export const PARTY_PHONE_PATTERN = /^[+]?[0-9()\-.\s]{7,20}$/;

/**
 * FluentValidation's built-in `EmailAddress()` rule, which since FluentValidation 9 is the ASP.NET
 * `EmailAddressAttribute` behaviour: exactly one `@`, with a non-empty local part and a non-empty
 * domain part containing no whitespace. It is NOT a full RFC 5322 parser, and reproducing a
 * stricter one here would reject addresses the reference accepts.
 */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/;

/** `RuleFor(x => x.Name).NotEmpty().MaximumLength(200)` (CreatePartyValidator.cs:15). */
const requiredPartyName = z
  .string({ message: 'NotNullValidator|Name is required.' })
  .max(200, { message: "MaximumLengthValidator|'Name' must be 200 characters or fewer." })
  .refine((value) => value.trim().length > 0, {
    message: "NotEmptyValidator|'Name' must not be empty.",
  });

/** `RuleFor(x => x.PartyTypeId).GreaterThan(0)` (:16). */
const requiredPartyTypeId = z
  .number({ message: "NotNullValidator|'Party Type Id' is required." })
  .int({ message: "InclusiveBetweenValidator|'Party Type Id' must be a whole number." })
  .positive({ message: "GreaterThanValidator|'Party Type Id' must be greater than 0." });

/** `long?` on the wire: a positive integer id, or null/absent. */
const optionalReferenceId = z
  .number()
  .int({ message: 'InclusiveBetweenValidator|Reference ids must be whole numbers.' })
  .positive({ message: 'GreaterThanValidator|Reference ids must be greater than 0.' })
  .nullish();

/** `RuleFor(x => x.ContactName).MaximumLength(200)` (:17) — note there is NO NotEmpty here. */
const optionalContactName = z
  .string()
  .max(200, { message: "MaximumLengthValidator|'Contact Name' must be 200 characters or fewer." })
  .nullish();

/**
 * `.EmailAddress().When(x => !string.IsNullOrWhiteSpace(x.ContactEmail))` (:18).
 *
 * THE `When` GUARD IS LOAD-BEARING AND IS PORTED AS A REFINEMENT, NOT AS `.email()`
 * ================================================================================
 * The rule does not run for null, absent, empty, OR ALL-WHITESPACE values — so `"   "` is VALID in
 * the reference and must stay valid here. `z.string().email().nullish()` would reject it, turning a
 * currently-200 SPA request into a 422.
 */
const optionalContactEmail = z
  .string()
  .nullish()
  .refine((value) => value == null || value.trim() === '' || EMAIL_PATTERN.test(value), {
    message: "EmailValidator|'Contact Email' is not a valid email address.",
  });

/** `.Matches(PartyContactValidation.PhonePattern()).When(...)` (:19-21) — same `When` semantics. */
const optionalContactPhone = z
  .string()
  .nullish()
  .refine((value) => value == null || value.trim() === '' || PARTY_PHONE_PATTERN.test(value), {
    message: "RegularExpressionValidator|'Contact Phone' is not in the correct format.",
  });

/**
 * `CreatePartyRequest`/`UpdatePartyRequest` (PartyEndpoints.cs:96-102).
 *
 * `isStrategic` is `bool?` on the wire and the endpoint applies `?? false` (:47, :66), so an absent
 * or null flag means NOT strategic — reproduced by the transform rather than by a zod `.default()`,
 * which would not fire for an explicit `null`.
 *
 * `.strict()` for the same reason reference-data uses it: a field this shape does not declare is a
 * client bug or an attempt to smuggle a column, and silently ignoring it hides both.
 */
export const partyWriteSchema = z
  .object({
    name: requiredPartyName,
    partyTypeId: requiredPartyTypeId,
    segmentId: optionalReferenceId,
    industryId: optionalReferenceId,
    regionId: optionalReferenceId,
    isStrategic: z.boolean().nullish(),
    contactName: optionalContactName,
    contactEmail: optionalContactEmail,
    contactPhone: optionalContactPhone,
  })
  .strict();

/** The sort keys `PartyStore.ApplySortAsync` (:150-180) recognises, bare or `-`-prefixed. */
export const PARTY_SORT_FIELDS = [
  'name',
  'type',
  'segment',
  'industry',
  'region',
  'strategic',
  'open_leads',
  'total_leads',
  'last_activity',
] as const;

export type PartySortField = (typeof PARTY_SORT_FIELDS)[number];

/**
 * The list query string (PartyEndpoints.cs:32-37).
 *
 * EVERY PARAMETER IS OPTIONAL AND AN UNPARSEABLE ONE IS IGNORED, NOT REJECTED
 * ==========================================================================
 * ASP.NET's minimal-API binder for a nullable `long?`/`bool?` query parameter binds NULL when the
 * value will not parse — it does not 400. So `?partyTypeId=abc` in the reference lists everything
 * rather than failing. That is reproduced with `.catch(...)` per field: answering 422 instead would
 * turn a currently-200 request into an error, which is a visible contract change on a URL any user
 * can hand-edit. `sort` is treated the same way (`SortSpec.Parse` falls back to the default order
 * for an unrecognised field, PartyStore.cs:179).
 */
export const listPartiesQuerySchema = z.object({
  search: z.string().optional().catch(undefined),
  partyTypeId: z.coerce.number().int().positive().optional().catch(undefined),
  segmentId: z.coerce.number().int().positive().optional().catch(undefined),
  industryId: z.coerce.number().int().positive().optional().catch(undefined),
  regionId: z.coerce.number().int().positive().optional().catch(undefined),
  strategic: z
    .string()
    .optional()
    .transform((value) => value?.toLowerCase())
    .transform((value) => (value === 'true' ? true : value === 'false' ? false : undefined))
    .catch(undefined),
  sort: z.string().optional().catch(undefined),
  page: z.coerce.number().int().optional().catch(undefined),
  pageSize: z.coerce.number().int().optional().catch(undefined),
});

export type PartyWriteInput = z.infer<typeof partyWriteSchema>;
export type ListPartiesQuery = z.infer<typeof listPartiesQuerySchema>;

/** Wire shape of `PartyDto`. */
export interface PartyDto {
  readonly id: number;
  readonly name: string;
  readonly partyTypeId: number;
  readonly segmentId: number | null;
  readonly industryId: number | null;
  readonly regionId: number | null;
  readonly isStrategic: boolean;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly lastActivityAt: string | null;
  readonly openLeadsCount: number;
  readonly totalLeadsCount: number;
}

/** Wire shape of `PartyWarningMatchDto`. */
export interface PartyWarningMatchDto {
  readonly id: number;
  readonly name: string;
}

/** `PartyWarningDto.DuplicateNameCode` (PartyDto.cs:57) — the only warning code emitted today. */
export const DUPLICATE_NAME_WARNING_CODE = 'DUPLICATE_NAME';

/** Wire shape of `PartyWarningDto`. */
export interface PartyWarningDto {
  readonly code: string;
  readonly matches: readonly PartyWarningMatchDto[];
}

/** Wire shape of `PartyMutationResultDto`. */
export interface PartyMutationResultDto {
  readonly party: PartyDto;
  readonly warnings: readonly PartyWarningDto[];
}

/** Wire shape of `PartyListDto` — `totalCount`, see the header. */
export interface PartyListDto {
  readonly items: readonly PartyDto[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * `LeadAssigneeDto`/`LeadListItemDto` (`Features/Leads/LeadDto.cs:9`, `:110-126`).
 *
 * DEFINED IN THE LEADS DOMAIN AND RE-EXPORTED HERE, deliberately. T-023 declared these locally
 * because the leads domain did not exist yet; T-024 owns them now, and the party detail's leads
 * card and the Leads list must project the IDENTICAL shape — they are the same reference DTO. Two
 * structurally-equal declarations would compile happily and then drift the first time one surface
 * gained a column, so there is exactly one definition and this is an alias to it.
 */
export type { LeadAssigneeDto, LeadListItemDto } from '../leads/schemas.js';
