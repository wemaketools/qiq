/**
 * User Manager request/response contracts (T-017, AC-029, AC-030).
 *
 * Ported field-for-field from the reference DTOs so `src/ui/src/features/userManager/usersApi.ts`
 * keeps working untouched:
 *
 *   UserDto(Id, FirstName, LastName, Email, IsActive, TenantIds)     Users/UserDto.cs:8
 *   CreateUserRequest(FirstName, LastName, Email, TenantIds,
 *                     DirectRoleIds, DirectPermissions, GroupIds)    UserEndpoints.cs:121
 *   CreateUserResult(UserId, Email, IsActive, EmailSent)             CreateUserCommand.cs:33
 *   UpdateUserRequest(FirstName, LastName, TenantIds,
 *                     RoleAssignments, PermissionAssignments,
 *                     GroupIds)                                      UserEndpoints.cs:130
 *   RoleAssignmentInput(RoleId, TenantId?)                           UpdateUserCommand.cs:6
 *   PermissionAssignmentInput(PermissionCode, TenantId?)             UpdateUserCommand.cs:9
 *   EffectiveAccessDto(...)                                          Users/UserDto.cs:38
 *
 * NOTE THE ASYMMETRY BETWEEN CREATE AND UPDATE — IT IS THE REFERENCE'S AND IS DELIBERATE.
 * Create takes FLAT lists (`directRoleIds`, `directPermissions`) that are applied across every
 * tenant in `tenantIds`; update takes PER-ASSIGNMENT objects each carrying their own `tenantId`,
 * because "a user can hold different roles/permissions/groups in different tenants" (P-03) and only
 * the update surface can express that. Collapsing the two into one shape would change the wire
 * contract the SPA already speaks.
 *
 * VALIDATION, PORTED FROM CreateUserValidator.cs / UpdateUserValidator.cs
 * ======================================================================
 *   FirstName  NotEmpty, MaximumLength(200)
 *   LastName   NotEmpty, MaximumLength(200)
 *   Email      NotEmpty, EmailAddress, MaximumLength(320)   (create only — email is immutable)
 *   DirectPermissions[*]  NotEmpty                          (create only)
 *
 * `NotEmpty()` rejects whitespace-only values, which `z.string().min(1)` accepts, hence the refine.
 * AC-029 requires 422 for a missing first name, last name, or email; that falls out of these rules.
 */
import { z } from 'zod';

function requiredText(label: string, max: number) {
  return z
    .string({ message: `NotNullValidator|${label} is required.` })
    .max(max, { message: `MaximumLengthValidator|'${label}' must be ${max} characters or fewer.` })
    .refine((value) => value.trim().length > 0, {
      message: `NotEmptyValidator|'${label}' must not be empty.`,
    });
}

/** `EmailAddress()` — FluentValidation's default is a permissive "has an @ with text around it". */
const requiredEmail = z
  .string({ message: 'NotNullValidator|Email is required.' })
  .max(320, { message: "MaximumLengthValidator|'Email' must be 320 characters or fewer." })
  .refine((value) => value.trim().length > 0, {
    message: "NotEmptyValidator|'Email' must not be empty.",
  })
  .refine((value) => z.email().safeParse(value).success, {
    message: "EmailValidator|'Email' is not a valid email address.",
  });

const idList = z.array(z.number().int()).nullish().transform((value) => value ?? []);
const nullableTenantId = z.number().int().nullish().transform((value) => value ?? null);

export const createUserSchema = z.object({
  firstName: requiredText('First Name', 200),
  lastName: requiredText('Last Name', 200),
  email: requiredEmail,
  tenantIds: idList,
  directRoleIds: idList,
  directPermissions: z
    .array(
      z.string().refine((value) => value.trim().length > 0, {
        message: "NotEmptyValidator|'Direct Permissions' entries must not be empty.",
      }),
    )
    .nullish()
    .transform((value) => value ?? []),
  groupIds: idList,
});

export const roleAssignmentSchema = z.object({
  roleId: z.number().int(),
  tenantId: nullableTenantId,
});

export const permissionAssignmentSchema = z.object({
  permissionCode: z.string(),
  tenantId: nullableTenantId,
});

export const updateUserSchema = z.object({
  firstName: requiredText('First Name', 200),
  lastName: requiredText('Last Name', 200),
  tenantIds: idList,
  roleAssignments: z
    .array(roleAssignmentSchema)
    .nullish()
    .transform((value) => value ?? []),
  permissionAssignments: z
    .array(permissionAssignmentSchema)
    .nullish()
    .transform((value) => value ?? []),
  groupIds: idList,
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type RoleAssignmentInput = z.infer<typeof roleAssignmentSchema>;
export type PermissionAssignmentInput = z.infer<typeof permissionAssignmentSchema>;

export interface UserDto {
  readonly id: number;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly isActive: boolean;
  readonly tenantIds: readonly number[];
}

export interface CreateUserResultDto {
  readonly userId: number;
  readonly email: string;
  readonly isActive: boolean;
  /** False when the best-effort initial-credential email failed; the account exists either way. */
  readonly emailSent: boolean;
}

export interface RoleAssignmentDto {
  readonly roleId: number;
  readonly roleName: string;
  readonly tenantId: number | null;
}

export interface PermissionAssignmentDto {
  readonly permissionCode: string;
  readonly tenantId: number | null;
}

export interface GroupMembershipDto {
  readonly groupId: number;
  readonly groupName: string;
  readonly tenantId: number | null;
}

export interface TenantAssignmentDto {
  readonly tenantId: number;
  readonly tenantName: string;
}

/**
 * `effectivePermissionsByTenant` is keyed by tenant id AS A STRING, plus the literal `"global"`
 * scope key (GetEffectiveAccessQueryHandler.cs:16,86). The SPA's `EffectiveAccessDto` already
 * declares exactly that `Record<string, string[]>`.
 */
export interface EffectiveAccessDto {
  readonly userId: number;
  readonly directRoles: readonly RoleAssignmentDto[];
  readonly directPermissions: readonly PermissionAssignmentDto[];
  readonly groups: readonly GroupMembershipDto[];
  readonly tenantAssignments: readonly TenantAssignmentDto[];
  readonly effectivePermissionsByTenant: Readonly<Record<string, readonly string[]>>;
}

/** The `"global"` scope key in `effectivePermissionsByTenant`. */
export const GLOBAL_SCOPE_KEY = 'global';
