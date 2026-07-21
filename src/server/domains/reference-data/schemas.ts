/**
 * Tenant reference-data request/response contracts (T-019, AC-035; spec §12 Settings).
 *
 * Ported field-for-field from the reference DTOs so the existing SPA keeps working unchanged
 * (`src/ui/src/features/settings/settingsApi.ts:52-91` already declares exactly these shapes):
 *   `ReferenceItemDto(Id, ListType, Name, DisplayOrder, IsActive, IsBrokerChannel, ProductLineId,
 *                     ReportingCategory, CanonicalKey, IsTerminal)`
 *     — src/api/QuoteIQ.Application/Features/ReferenceData/ReferenceItemDto.cs:7-17
 *   `CreateItemRequest(Name, IsBrokerChannel, ProductLineId, ReportingCategory)`
 *     — src/api/QuoteIQ.Api/Endpoints/ReferenceDataEndpoints.cs:137
 *   `UpdateItemRequest(...)` — identical shape (:139)
 *   `ReorderItemsRequest(OrderedIds)` (:141)
 *
 * NOTE WHAT THE WRITE REQUESTS DO NOT CONTAIN: no `canonicalKey`, no `isTerminal`, no `displayOrder`
 * and no `isActive`. That is the guard, not an oversight (CreateItemCommand.cs:7-11): a canonical key
 * and the terminal flag are set exclusively by the tenant-creation seed, ordering is set exclusively
 * by the reorder endpoint, and activation is set exclusively by disable. A body field for any of
 * them would be a way to smuggle a tenant-invented "won" status past the guarded taxonomy, so the
 * schemas below reject unknown keys rather than merely ignoring them.
 *
 * VALIDATION IS PER LIST TYPE, WHICH IS WHY THIS IS A FUNCTION
 * ===========================================================
 * `CreateItemValidator` (CreateItemValidator.cs:13-28) applies two of its three rules under
 * `.When(x => x.ListType == ...)`, so the schema genuinely differs by list type. Building it from
 * the parsed list type keeps that conditionality in one expression instead of re-deriving it inside
 * handlers.
 *
 * AND WHY CREATE AND UPDATE DIFFER (A PORTED ASYMMETRY, NOT A SIMPLIFICATION)
 * ==========================================================================
 * `UpdateItemValidator` (UpdateItemValidator.cs:7-11) has ONLY the name rules — no product-line
 * rule, no reporting-category rule. The update path's equivalents live in the handler instead
 * (UpdateItemCommandHandler.cs:63-85), where they produce DIFFERENT error codes than create's
 * validator would (`REFERENCE_DATA_REPORTING_CATEGORY_REQUIRED` /
 * `REFERENCE_DATA_INVALID_INTERMEDIATE_CATEGORY` rather than `REFERENCE_DATA_VALIDATION_FAILED`),
 * and the reference's own tests pin those codes (ReferenceDataEndpointsTests.cs:157,184,212).
 * Collapsing the two schemas into one would change the code a client sees on update, so they stay
 * apart.
 */
import { z } from 'zod';

import { REPORTING_CATEGORIES } from './canonical-statuses.js';
import { isStatusListType, requiresProductLine, type ReferenceListType } from './list-types.js';

/** FluentValidation `NotEmpty().MaximumLength(200)` on `Name` (both validators). */
const requiredItemName = z
  .string({ message: 'NotNullValidator|Name is required.' })
  .max(200, { message: "MaximumLengthValidator|'Name' must be 200 characters or fewer." })
  .refine((value) => value.trim().length > 0, {
    message: "NotEmptyValidator|'Name' must not be empty.",
  });

/** `long?` on the wire: a positive integer id, or null/absent. */
const optionalId = z
  .number()
  .int({ message: "InclusiveBetweenValidator|'Product Line Id' must be a whole number." })
  .positive({ message: "GreaterThanValidator|'Product Line Id' must be greater than 0." })
  .nullish();

const optionalBoolean = z.boolean().nullish();

const optionalReportingCategory = z.string().nullish();

const REPORTING_CATEGORY_LIST = REPORTING_CATEGORIES.join(', ');

/**
 * `CreateItemValidator`, conditional rules included.
 *
 * The reporting-category rules reproduce FluentValidation's evaluation order exactly: `NotEmpty()`
 * and `Must(...)` are SEPARATE rules on the same property, and `Must` returns true for null. So a
 * NULL category yields ONE message ("...require a reporting category.") and an UNRECOGNIZED string
 * yields the other ("Reporting category must be one of: ..."), never both.
 *
 * THE CONDITIONAL FIELDS ARE REQUIRED-AND-TYPED, NOT `optional().refine(...)` — A ZOD TRAP
 * =======================================================================================
 * `z.number().nullish().refine(v => v != null, ...)` looks like the obvious spelling and DOES NOT
 * WORK: zod short-circuits an optional schema on `undefined` and never runs the outer refinement,
 * so a cover type posted with no `productLineId` at all sailed past validation. It was then caught
 * one layer down by the service's `productLineRequiredError()` — a 422 either way, which is exactly
 * why this was invisible to a status-code-only test and was only caught by asserting the reference's
 * message. Requiring the field outright puts the failure back where `CreateItemValidator` had it,
 * with the reference's `REFERENCE_DATA_VALIDATION_FAILED` code and message.
 */
export function createItemSchema(listType: ReferenceListType) {
  const requiredProductLineId = z
    .number({ message: 'NotNullValidator|Cover types require a product line.' })
    .int({ message: "InclusiveBetweenValidator|'Product Line Id' must be a whole number." })
    .positive({ message: "GreaterThanValidator|'Product Line Id' must be greater than 0." });

  const requiredReportingCategory = z
    .string({ message: 'NotEmptyValidator|Lead/quote statuses require a reporting category.' })
    .refine((value) => value.trim() !== '', {
      message: 'NotEmptyValidator|Lead/quote statuses require a reporting category.',
    })
    .refine((value) => (REPORTING_CATEGORIES as readonly string[]).includes(value), {
      message: `EnumValidator|Reporting category must be one of: ${REPORTING_CATEGORY_LIST}.`,
    });

  return z
    .object({
      name: requiredItemName,
      isBrokerChannel: optionalBoolean,
      productLineId: requiresProductLine(listType) ? requiredProductLineId : optionalId,
      reportingCategory: isStatusListType(listType)
        ? requiredReportingCategory
        : optionalReportingCategory,
    })
    .strict();
}

/** `UpdateItemValidator`: name only — see the header for why this is not `createItemSchema`. */
export const updateItemSchema = z
  .object({
    name: requiredItemName,
    isBrokerChannel: optionalBoolean,
    productLineId: optionalId,
    reportingCategory: optionalReportingCategory,
  })
  .strict();

/**
 * `ReorderItemsRequest(IReadOnlyList<long> OrderedIds)` (:141).
 *
 * REPORTED DEVIATION: the reference has NO validator on this command, so a body with a missing or
 * null `orderedIds` dereferences null in ReorderItemsCommandHandler.cs:36 and produces a 500. This
 * port validates the shape and answers 422 through the ordinary
 * `REFERENCE_DATA_VALIDATION_FAILED` path instead. An empty array is still ACCEPTED here, because
 * it is a meaningful request against an empty list and the handler's set-equality check is what
 * decides it (an empty array against a non-empty active set is a REORDER_SET_MISMATCH, which is the
 * reference's own answer for it).
 */
export const reorderItemsSchema = z
  .object({
    orderedIds: z.array(
      z
        .number({ message: 'NotNullValidator|Ordered ids must be whole numbers.' })
        .int({ message: 'InclusiveBetweenValidator|Ordered ids must be whole numbers.' })
        .positive({ message: 'GreaterThanValidator|Ordered ids must be greater than 0.' }),
      { message: "NotNullValidator|'Ordered Ids' is required." },
    ),
  })
  .strict();

/**
 * `bool? includeDisabled` bound from the query string (ReferenceDataEndpoints.cs:39,47). Same
 * binder semantics — and the same ported treatment — as Tenant Manager's `includeRemoved`
 * (tenants/schemas.ts:68-83): missing means false, `true`/`false` parse case-insensitively, and an
 * unparseable value is a 422 here where ASP.NET's binder would have produced a 400.
 */
export const listItemsQuerySchema = z.object({
  includeDisabled: z
    .string()
    .optional()
    .transform((value) => value?.toLowerCase())
    .refine((value) => value === undefined || value === 'true' || value === 'false', {
      message: "EnumValidator|'includeDisabled' must be true or false.",
    })
    .transform((value) => value === 'true'),
});

export type CreateItemInput = z.infer<ReturnType<typeof createItemSchema>>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type ReorderItemsInput = z.infer<typeof reorderItemsSchema>;

/** Wire shape of `ReferenceItemDto`. */
export interface ReferenceItemDto {
  readonly id: number;
  readonly listType: string;
  readonly name: string;
  readonly displayOrder: number;
  readonly isActive: boolean;
  readonly isBrokerChannel: boolean | null;
  readonly productLineId: number | null;
  readonly reportingCategory: string | null;
  readonly canonicalKey: string | null;
  readonly isTerminal: boolean;
}
