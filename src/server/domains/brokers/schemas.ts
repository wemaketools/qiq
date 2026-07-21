/**
 * Broker request/response contracts (T-021, AC-039; spec §12 Settings brokers).
 *
 * Ported field-for-field from the reference DTOs so the existing SPA keeps working unchanged
 * (`src/ui/src/features/settings/settingsApi.ts:181-217` already declares exactly these shapes):
 *   `BrokerSummaryDto(Id, Name, BrokerTypeId, Branch, Status)`      — BrokerDto.cs:13
 *   `BrokerContactDto(Id, Name, Email, Phone, IsPrimary)`           — BrokerDto.cs:6
 *   `BrokerDetailDto(..., Contacts)`                                — BrokerDto.cs:20-21
 *   `BrokerListDto(Items, TotalCount, Page, PageSize)`              — BrokerDto.cs:33
 *   `CreateBrokerRequest(Name, BrokerTypeId, Branch)`               — BrokerEndpoints.cs:147
 *   `UpdateBrokerRequest(Name, BrokerTypeId, Branch)`               — BrokerEndpoints.cs:149
 *   `AddContactRequest(Name, Email, Phone, IsPrimary)`              — BrokerEndpoints.cs:151
 *   `UpdateContactRequest(Name, Email, Phone)`                      — BrokerEndpoints.cs:153
 *
 * THE LIST ENVELOPE FIELD IS `totalCount`, NOT `total`
 * ====================================================
 * T-021's task file says `{items,page,pageSize,total}`. The reference record is
 * `BrokerListDto(Items, TotalCount, Page, PageSize)` and the SPA's interface reads `totalCount`
 * (settingsApi.ts:207-212). The measured contract wins; renaming it would break the Settings tab.
 *
 * NOTE WHAT THE WRITE REQUESTS DO NOT CONTAIN. There is no `status` on either broker request and no
 * `isPrimary` on the contact UPDATE request. That is the guard, not an oversight: status is set
 * exclusively by the disable endpoint (UpdateBrokerCommand.cs:6) and the primary marker exclusively
 * by set-primary (UpdateContactCommand.cs:6), each of which enforces an invariant a plain field
 * write would bypass. The schemas are therefore `.strict()` — an unknown key is REJECTED rather than
 * ignored, matching the sibling reference-data port, so an attempt to smuggle either one is a loud
 * 422 instead of a silent no-op. ASP.NET's binder would have ignored it; this is a reported,
 * deliberate tightening and the suite pins both refusals.
 */
import { z } from 'zod';

/** FluentValidation `NotEmpty().MaximumLength(200)` on `Name` (CreateBrokerValidator.cs:15). */
const requiredName = z
  .string({ message: 'NotNullValidator|Name is required.' })
  .max(200, { message: "MaximumLengthValidator|'Name' must be 200 characters or fewer." })
  .refine((value) => value.trim().length > 0, {
    message: "NotEmptyValidator|'Name' must not be empty.",
  });

/** `RuleFor(x => x.Branch).MaximumLength(200)` (:16) — optional, so null/absent is legal. */
const optionalBranch = z
  .string()
  .max(200, { message: "MaximumLengthValidator|'Branch' must be 200 characters or fewer." })
  .nullish();

/** `long?` on the wire: a positive integer id, or null/absent. */
const optionalBrokerTypeId = z
  .number()
  .int({ message: "InclusiveBetweenValidator|'Broker Type Id' must be a whole number." })
  .positive({ message: "GreaterThanValidator|'Broker Type Id' must be greater than 0." })
  .nullish();

/**
 * `RuleFor(x => x.Email).EmailAddress().When(x => !string.IsNullOrWhiteSpace(x.Email))`
 * (AddContactValidator.cs:10).
 *
 * THE `.When(...)` IS LOAD-BEARING AND IS WHY THIS IS NOT `z.string().email().nullish()`. Zod's
 * `.email()` rejects the empty string and a whitespace-only string; FluentValidation's guarded rule
 * does not run on either. A form that posts `email: ""` for "no email" is a 201 in the reference, so
 * the format check is applied only to a value with non-whitespace content.
 */
const optionalEmail = z
  .string()
  .nullish()
  .refine(
    (value) =>
      value === null ||
      value === undefined ||
      value.trim() === '' ||
      z.string().email().safeParse(value).success,
    { message: "EmailValidator|'Email' is not a valid email address." },
  );

/** `RuleFor(x => x.Phone).MaximumLength(50)` (:11). */
const optionalPhone = z
  .string()
  .max(50, { message: "MaximumLengthValidator|'Phone' must be 50 characters or fewer." })
  .nullish();

/** `CreateBrokerRequest` (BrokerEndpoints.cs:147) validated by `CreateBrokerValidator`. */
export const createBrokerSchema = z
  .object({
    name: requiredName,
    brokerTypeId: optionalBrokerTypeId,
    branch: optionalBranch,
  })
  .strict();

/**
 * `UpdateBrokerRequest` (:149) validated by `UpdateBrokerValidator`.
 *
 * Identical to create, and deliberately so: `UpdateBrokerCommandHandler.cs:57-59` assigns all three
 * fields UNCONDITIONALLY, so an omitted `brokerTypeId`/`branch` CLEARS the stored value. That is a
 * full replace, not a patch, and the schema says so by not marking anything as "leave alone".
 */
export const updateBrokerSchema = createBrokerSchema;

/** `AddContactRequest` (:151). `isPrimary` is a REQUEST, not a decision — see service.ts. */
export const addContactSchema = z
  .object({
    name: requiredName,
    email: optionalEmail,
    phone: optionalPhone,
    isPrimary: z.boolean().nullish(),
  })
  .strict();

/** `UpdateContactRequest` (:153). No `isPrimary` — see the header. */
export const updateContactSchema = z
  .object({
    name: requiredName,
    email: optionalEmail,
    phone: optionalPhone,
  })
  .strict();

/**
 * `ListBrokersAsync`'s query binding (BrokerEndpoints.cs:45-49).
 *
 * `status` and `search` are FREE STRINGS in the reference — an unrecognized status is simply a
 * predicate that matches nothing (BrokerStore.cs:40-43), not a validation error — so neither is
 * constrained here.
 *
 * `page`/`pageSize` are `int?`: absent means the handler's defaults (1 and 25), and
 * `ListBrokersQueryHandler.cs:15-16` then clamps a value below 1 back to those same defaults. An
 * UNPARSEABLE value is a 400 from ASP.NET's binder; here it is a 422 through the ordinary
 * `BROKER_VALIDATION_FAILED` path, the same treatment (and the same reported deviation) as
 * reference-data's `includeDisabled` and Tenant Manager's `includeRemoved`.
 *
 * THERE IS NO UPPER BOUND ON `pageSize`, WHICH IS THE REFERENCE'S BEHAVIOUR AND IS RELIED ON.
 * `settingsApi.listBrokers()` requests `pageSize=200` because the Settings tab does not paginate.
 * Capping it here would silently truncate that screen. Flagged in the task file rather than
 * "fixed".
 */
const optionalIntQueryParam = (label: string) =>
  z
    .string()
    .optional()
    .refine((value) => value === undefined || /^-?\d+$/.test(value), {
      message: `InclusiveBetweenValidator|'${label}' must be a whole number.`,
    })
    .transform((value) => (value === undefined ? undefined : Number(value)));

export const listBrokersQuerySchema = z.object({
  status: z.string().optional(),
  search: z.string().optional(),
  brokerTypeId: optionalIntQueryParam('Broker Type Id'),
  page: optionalIntQueryParam('Page'),
  pageSize: optionalIntQueryParam('Page Size'),
});

export type CreateBrokerInput = z.infer<typeof createBrokerSchema>;
export type UpdateBrokerInput = z.infer<typeof updateBrokerSchema>;
export type AddContactInput = z.infer<typeof addContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
export type ListBrokersQuery = z.infer<typeof listBrokersQuerySchema>;

/** Wire shape of `BrokerContactDto`. */
export interface BrokerContactDto {
  readonly id: number;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly isPrimary: boolean;
}

/** Wire shape of `BrokerSummaryDto` — the picker-safe projection, with NO contacts. */
export interface BrokerSummaryDto {
  readonly id: number;
  readonly name: string;
  readonly brokerTypeId: number | null;
  readonly branch: string | null;
  readonly status: string;
}

/** Wire shape of `BrokerDetailDto`. */
export interface BrokerDetailDto extends BrokerSummaryDto {
  readonly contacts: readonly BrokerContactDto[];
}

/** Wire shape of `BrokerListDto`. */
export interface BrokerListDto {
  readonly items: readonly BrokerSummaryDto[];
  readonly totalCount: number;
  readonly page: number;
  readonly pageSize: number;
}
