/**
 * Tenant Manager request/response contracts (T-016, AC-028; spec §12 Tenant Manager).
 *
 * Ported field-for-field from the reference DTOs so the existing SPA keeps working:
 *   `TenantDto(Id, Name, ContactName, ContactEmail, ContactPhone, Status, RemovedAt)`
 *     — src/api/QuoteIQ.Application/Features/Tenants/TenantDto.cs:6-13
 *   `CreateTenantResult(TenantId, Name, Status)`
 *     — .../CreateTenant/CreateTenantCommand.cs:13
 *   `UpdateTenantRequest(Name, ContactName, ContactEmail, ContactPhone)`
 *     — src/api/QuoteIQ.Api/Endpoints/TenantEndpoints.cs:97
 * ASP.NET serialises these camelCase, which is the shape reproduced here.
 *
 * VALIDATION — PORTED FROM FluentValidation, INCLUDING ITS QUIRKS
 * ==============================================================
 * `CreateTenantValidator` (CreateTenantValidator.cs:9-12) is the whole rule set, and
 * `UpdateTenantValidator` is identical:
 *
 *     RuleFor(x => x.Name).NotEmpty().MaximumLength(200);
 *     RuleFor(x => x.ContactEmail).EmailAddress().When(!string.IsNullOrWhiteSpace(ContactEmail));
 *
 * Three consequences are preserved deliberately rather than "improved":
 *   1. NAME IS THE ONLY REQUIRED FIELD (MVP, spec §12) — every contact field is optional.
 *   2. `NotEmpty()` rejects a WHITESPACE-ONLY name, which `z.string().min(1)` would accept, so the
 *      refinement below re-adds that. The 200-char limit is measured on the raw string.
 *   3. A BLANK contact email is accepted and stored as-is (the `.When` guard skips the format rule
 *      for null/empty/whitespace). Only a non-blank, malformed address is rejected.
 *
 * THE STORED NAME IS NOT TRIMMED — a REPORTED divergence candidate that was NOT taken.
 * The reference stores `command.Name` verbatim (CreateTenantCommandHandler.cs:56) and compares
 * names with `ToLower()` only (TenantStore.cs:25-30), so `"  Acme "` and `"Acme"` are two different
 * active tenants there. Trimming here would be a behaviour change to data, not just to validation,
 * and would silently diverge from the reference's duplicate rule and from the partial unique index
 * `uq_tenants_active_name (lower(name)) where status='active'`. Ported as-is and flagged.
 */
import { z } from 'zod';

/** FluentValidation `NotEmptyValidator` semantics: null/empty/whitespace all fail. */
const requiredTenantName = z
  .string({ message: 'NotNullValidator|Name is required.' })
  .max(200, { message: "MaximumLengthValidator|'Name' must be 200 characters or fewer." })
  .refine((value) => value.trim().length > 0, {
    message: "NotEmptyValidator|'Name' must not be empty.",
  });

/**
 * `EmailAddress()` guarded by `.When(!IsNullOrWhiteSpace)`. `null`, `undefined`, `""` and `"   "`
 * are all accepted unchanged; anything else must look like an address.
 */
const optionalContactEmail = z
  .string()
  .nullish()
  .refine((value) => value == null || value.trim() === '' || z.email().safeParse(value).success, {
    message: "EmailValidator|'Contact Email' is not a valid email address.",
  });

const optionalContactField = z.string().nullish();

export const createTenantSchema = z.object({
  name: requiredTenantName,
  contactName: optionalContactField,
  contactEmail: optionalContactEmail,
  contactPhone: optionalContactField,
});

/** `UpdateTenantRequest` carries the same fields; the id comes from the route, not the body. */
export const updateTenantSchema = createTenantSchema;

/**
 * `bool? includeRemoved` bound from the query string (TenantEndpoints.cs:34,37). ASP.NET's bool
 * binder accepts `true`/`false` case-insensitively and treats a missing value as null -> false.
 * An unparseable value is a 400 there; here it is a 422 through the same validation path, which is
 * the closest available shape and is asserted in the suite rather than assumed.
 */
export const listTenantsQuerySchema = z.object({
  includeRemoved: z
    .string()
    .optional()
    .transform((value) => value?.toLowerCase())
    .refine((value) => value === undefined || value === 'true' || value === 'false', {
      message: "EnumValidator|'includeRemoved' must be true or false.",
    })
    .transform((value) => value === 'true'),
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;

/** Wire shape of `TenantDto`. */
export interface TenantDto {
  readonly id: number;
  readonly name: string;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly status: string;
  readonly removedAt: string | null;
}

/** Wire shape of `CreateTenantResult`. */
export interface CreateTenantResultDto {
  readonly tenantId: number;
  readonly name: string;
  readonly status: string;
}

/** The two values `ck_tenants_status` permits. */
export const TENANT_STATUS_ACTIVE = 'active';
export const TENANT_STATUS_REMOVED = 'removed';
