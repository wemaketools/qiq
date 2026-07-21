/**
 * Role/group/permission request + response contracts (T-017, AC-030).
 *
 * Ported field-for-field from the reference DTOs so `src/ui/src/features/userManager/rolesApi.ts`
 * and `groupsApi.ts` keep working untouched:
 *
 *   RoleDto(Id, TenantId, Name, IsActive, PermissionCodes)          Roles/RoleDto.cs:6
 *   RoleUsageUserDto(UserId, Email, TenantId)                       Roles/RoleDto.cs:12
 *   RoleUsageGroupDto(GroupId, Name, TenantId)                      Roles/RoleDto.cs:14
 *   RoleUsageDto(Users, Groups)                                     Roles/RoleDto.cs:16
 *   GroupDto(Id, TenantId, Name, IsActive)                          Groups/GroupDto.cs:6
 *   GroupDetailDto(Id, TenantId, Name, IsActive,
 *                  MemberUserIds, RoleIds, PermissionCodes)         Groups/GroupDto.cs:11
 *
 * VALIDATION, PORTED FROM FluentValidation INCLUDING `NotEmpty()`'s WHITESPACE RULE
 * ===============================================================================
 * `CreateRoleValidator` / `UpdateRoleValidator` / `CreateGroupValidator` / `UpdateGroupValidator`
 * are each exactly `RuleFor(x => x.Name).NotEmpty().MaximumLength(200)`. `NotEmpty()` rejects a
 * whitespace-only name, which `z.string().min(1)` would happily accept, so the refinement below
 * re-adds that — the same divergence `domains/tenants/schemas.ts` documents.
 *
 * Missing collections are `?? []` at the reference's endpoint layer (RoleEndpoints.cs:44,54;
 * GroupEndpoints.cs:95,102), so they default here rather than being required.
 */
import { z } from 'zod';

const requiredName = z
  .string({ message: 'NotNullValidator|Name is required.' })
  .max(200, { message: "MaximumLengthValidator|'Name' must be 200 characters or fewer." })
  .refine((value) => value.trim().length > 0, {
    message: "NotEmptyValidator|'Name' must not be empty.",
  });

const permissionCodeList = z.array(z.string()).nullish().transform((value) => value ?? []);
const idList = z.array(z.number().int()).nullish().transform((value) => value ?? []);

export const createRoleSchema = z.object({
  name: requiredName,
  permissionCodes: permissionCodeList,
  global: z.boolean().nullish().transform((value) => value ?? false),
});

/** `UpdateRoleRequest(Name, PermissionCodes)` — the tenant scope is immutable after creation. */
export const updateRoleSchema = z.object({
  name: requiredName,
  permissionCodes: permissionCodeList,
});

/** `DisableRoleRequest(bool? Force)`; the whole body is optional (RoleEndpoints.cs:60). */
export const disableRoleSchema = z.object({
  force: z.boolean().nullish().transform((value) => value ?? false),
});

export const createGroupSchema = z.object({
  name: requiredName,
  global: z.boolean().nullish().transform((value) => value ?? false),
});

export const updateGroupSchema = z.object({ name: requiredName });

export const addGroupMemberSchema = z.object({ userId: z.number().int() });

export const setGroupRolesSchema = z.object({ roleIds: idList });

export const setGroupPermissionsSchema = z.object({ permissionCodes: permissionCodeList });

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type DisableRoleInput = z.infer<typeof disableRoleSchema>;
export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type AddGroupMemberInput = z.infer<typeof addGroupMemberSchema>;
export type SetGroupRolesInput = z.infer<typeof setGroupRolesSchema>;
export type SetGroupPermissionsInput = z.infer<typeof setGroupPermissionsSchema>;

export interface RoleDto {
  readonly id: number;
  readonly tenantId: number | null;
  readonly name: string;
  readonly isActive: boolean;
  readonly permissionCodes: readonly string[];
}

export interface RoleUsageDto {
  readonly users: readonly { userId: number; email: string; tenantId: number | null }[];
  readonly groups: readonly { groupId: number; name: string; tenantId: number | null }[];
}

export interface GroupDto {
  readonly id: number;
  readonly tenantId: number | null;
  readonly name: string;
  readonly isActive: boolean;
}

export interface GroupDetailDto extends GroupDto {
  readonly memberUserIds: readonly number[];
  readonly roleIds: readonly number[];
  readonly permissionCodes: readonly string[];
}

/** `GET /permissions` — the shape the SPA's static mirror already declares. */
export interface PermissionCatalogDto {
  readonly code: string;
  readonly category: string;
  readonly description: string;
}
