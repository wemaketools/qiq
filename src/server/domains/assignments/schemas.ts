/**
 * Business-assignment slot request/response contract (T-020, AC-038; spec FR-23 as amended
 * 2026-07-15, §12 Settings).
 *
 * Ported field-for-field from
 * `src/api/QuoteIQ.Application/Features/BusinessAssignments/BusinessAssignmentsDto.cs:6-25` and the
 * write shape `UpdateBusinessAssignmentsRequest`
 * (src/api/QuoteIQ.Api/Endpoints/BusinessAssignmentEndpoints.cs:110). The SPA already declares
 * exactly these shapes (`src/ui/src/features/settings/settingsApi.ts:139-154`).
 *
 * TWO FIXED SLOTS. THAT IS THE WHOLE MODEL.
 * =========================================
 * `rm` (a lead's accountable owner) and `underwriter` (what Send-to-underwriting and quote
 * assignment target), one role each per tenant. There is no `applies_to` list, no `display_order`,
 * no `is_accountable_owner` flag and no role-name heuristic — changeset 170 deleted all of them on
 * 2026-07-15 (20260718002300_business_assignments.sql:20-27), replacing the .NET
 * `SendToUnderwritingCommandHandler`'s `/underwrit/i` name match with an explicit slot.
 *
 * The "exactly two slots, one role each" invariant is STRUCTURAL, not a schema rule: the write
 * shape has precisely two nullable fields, so a third slot is unrepresentable and a second role in
 * one slot is unspellable. Beneath that, `ck_business_assignments_slot` and
 * `uq_business_assignments_tenant_slot` enforce the same thing in the database. AC-038's "adding a
 * third slot -> 422" is therefore answered by an unknown key being rejected, which is why THIS
 * schema is strict where business-rules' is not: here an unrecognized key is precisely the third
 * slot someone tried to invent, and silently stripping it would answer 200 to a request that did
 * nothing.
 */
import { z } from 'zod';

/** The two slot values, matching `ck_business_assignments_slot` and `BusinessAssignmentSlot.cs`. */
export const ASSIGNMENT_SLOTS = ['rm', 'underwriter'] as const;

export type AssignmentSlot = (typeof ASSIGNMENT_SLOTS)[number];

export const RM_SLOT: AssignmentSlot = 'rm';
export const UNDERWRITER_SLOT: AssignmentSlot = 'underwriter';

/** `BusinessAssignmentErrors.SlotLabel` (:21-22) — the wording the 409 message uses. */
export function slotLabel(slot: AssignmentSlot): string {
  return slot === UNDERWRITER_SLOT ? 'Underwriting' : 'RM';
}

/** `long?` on the wire: a positive integer role id, or an explicit null meaning "clear this slot". */
const optionalRoleId = z
  .number({ message: "NotNullValidator|A role id must be a number or null." })
  .int({ message: "InclusiveBetweenValidator|A role id must be a whole number." })
  .positive({ message: "GreaterThanValidator|A role id must be greater than 0." })
  .nullable();

export const updateBusinessAssignmentsSchema = z
  .object({
    // `.nullable()` then `.default(null)`: an OMITTED slot is treated as null, exactly as C#
    // binding produces `null` for an absent `long?`. So a PUT carrying only `rmRoleId` CLEARS the
    // underwriter slot — a full-replace contract, not a patch. The SPA always sends both
    // (settingsApi.ts:151-154), and the 409 in-use guard is what stops that from silently
    // orphaning live assignees.
    rmRoleId: optionalRoleId.default(null),
    underwritingRoleId: optionalRoleId.default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    // `UpdateBusinessAssignmentsValidator` (:14-18). The RM slot (lead accountable owner) and the
    // Underwriting slot (send-to-underwriting / quote assignment) are distinct responsibilities;
    // one role holding both would make the two eligible-user pickers return identical sets, so a
    // "reassign to underwriting" would be indistinguishable from a no-op.
    if (
      value.rmRoleId !== null &&
      value.underwritingRoleId !== null &&
      value.rmRoleId === value.underwritingRoleId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['underwritingRoleId'],
        message: 'PredicateValidator|The RM role and the Underwriting role must be different roles.',
      });
    }
  });

export type UpdateBusinessAssignmentsInput = z.infer<typeof updateBusinessAssignmentsSchema>;

/** `BusinessAssignmentEntryDto(AssignmentId, RoleId, RoleName)` (:6). */
export interface BusinessAssignmentEntryDto {
  readonly assignmentId: number;
  readonly roleId: number;
  readonly roleName: string;
}

/**
 * `BusinessAssignmentsDto(RmRole, UnderwritingRole)` (:14-15).
 *
 * NOTE THE FIELD NAME ASYMMETRY, WHICH IS THE REFERENCE'S: the slot COLUMN values are `rm` and
 * `underwriter`, but the DTO fields are `rmRole` and `underwriting`Role. Preserved rather than
 * harmonised — the SPA reads `underwritingRole` (settingsApi.ts:148).
 */
export interface BusinessAssignmentsDto {
  readonly rmRole: BusinessAssignmentEntryDto | null;
  readonly underwritingRole: BusinessAssignmentEntryDto | null;
}

/**
 * `EligibleAssigneeDto(UserId, FirstName, LastName, Email)`
 * (src/api/QuoteIQ.Application/Features/BusinessAssignments/EligibleAssigneeDto.cs:6), returned by
 * both picker routes as a BARE JSON ARRAY — `Results.Ok(IReadOnlyList<EligibleAssigneeDto>)`
 * (BusinessAssignmentEndpoints.cs:71,80). There is deliberately NO pagination envelope on these
 * routes, so no `total`/`totalCount` field exists to get wrong; the SPA declares the same bare
 * array (settingsApi.ts:166-171, leadsApi.ts:549,559).
 */
export interface EligibleAssigneeDto {
  readonly userId: number;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
}

/**
 * `GET .../eligible-users?assignmentId={long}&search={string?}`
 * (BusinessAssignmentEndpoints.cs:62-63).
 *
 * `assignmentId` is a REQUIRED `long` minimal-API query binding, so a missing or unparseable value
 * fails model binding with a 400 BEFORE the handler runs — it is not a 422 validation failure and
 * not a 404. `search` is `string?`: absent and blank are equivalent (the reader guards with
 * `IsNullOrWhiteSpace`).
 */
export const eligibleUsersQuerySchema = z.object({
  assignmentId: z
    .string({ message: "REQUIRED|'assignmentId' is required." })
    .regex(/^\d+$/, { message: "INVALID|'assignmentId' must be a positive whole number." })
    .transform((value) => Number(value))
    .refine((value) => Number.isSafeInteger(value) && value > 0, {
      message: "INVALID|'assignmentId' must be a positive whole number.",
    }),
  search: z.string().nullish(),
});

/** `GET .../eligible-approvers?search={string?}` (:70) — no required parameter at all. */
export const eligibleApproversQuerySchema = z.object({
  search: z.string().nullish(),
});
