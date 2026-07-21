import { apiGet, apiPost, apiPut } from '../../api/client';

/**
 * User Manager backend contract (src/api/QuoteIQ.Api/Endpoints/UserEndpoints.cs,
 * src/api/QuoteIQ.Application/Features/Users/*, System.Text.Json camelCase defaults). Tenant-scoped
 * (requires `X-Tenant-Id`, per T-007's `TenantScopedGroup`) — Internal callers reach across tenants
 * via the same `global.view_any_tenant` + cross-tenant plumbing as every other Settings-style
 * feature (T-008/T-010/T-014). This module is the single place User Manager screens call the API
 * from, matching the fetch-wrapper convention established by `tenantManager/tenantsApi.ts` (T-014) —
 * this codebase has no RTK Query configured yet, so this mirrors that same plain-fetch shape rather
 * than the RTK Query module the T-015 task brief describes (flagged deviation, consistent with T-014).
 */
export interface UserDto {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  isActive: boolean;
  tenantIds: number[];
}

export interface CreateUserPayload {
  firstName: string;
  lastName: string;
  email: string;
  tenantIds: number[];
  directRoleIds: number[];
  directPermissions: string[];
  groupIds: number[];
}

export interface CreateUserResult {
  userId: number;
  email: string;
  isActive: boolean;
  emailSent: boolean;
}

export interface RoleAssignmentInput {
  roleId: number;
  tenantId: number | null;
}

export interface PermissionAssignmentInput {
  permissionCode: string;
  tenantId: number | null;
}

export interface UpdateUserPayload {
  firstName: string;
  lastName: string;
  tenantIds: number[];
  roleAssignments: RoleAssignmentInput[];
  permissionAssignments: PermissionAssignmentInput[];
  groupIds: number[];
}

export interface RoleAssignmentDto {
  roleId: number;
  roleName: string;
  tenantId: number | null;
}

export interface PermissionAssignmentDto {
  permissionCode: string;
  tenantId: number | null;
}

export interface GroupMembershipDto {
  groupId: number;
  groupName: string;
  tenantId: number | null;
}

export interface TenantAssignmentDto {
  tenantId: number;
  tenantName: string;
}

/** Keyed by tenant id as a string, plus the literal `"global"` scope key (see GetEffectiveAccessQueryHandler). */
export interface EffectiveAccessDto {
  userId: number;
  directRoles: RoleAssignmentDto[];
  directPermissions: PermissionAssignmentDto[];
  groups: GroupMembershipDto[];
  tenantAssignments: TenantAssignmentDto[];
  effectivePermissionsByTenant: Record<string, string[]>;
}

export function listUsers(): Promise<UserDto[]> {
  return apiGet<UserDto[]>('/users');
}

export function getUser(id: number): Promise<UserDto> {
  return apiGet<UserDto>(`/users/${id}`);
}

export function createUser(payload: CreateUserPayload): Promise<CreateUserResult> {
  return apiPost<CreateUserResult>('/users', payload);
}

export function updateUser(id: number, payload: UpdateUserPayload): Promise<UserDto> {
  return apiPut<UserDto>(`/users/${id}`, payload);
}

export function deactivateUser(id: number): Promise<void> {
  return apiPost<void>(`/users/${id}/deactivate`);
}

export function getEffectiveAccess(id: number): Promise<EffectiveAccessDto> {
  return apiGet<EffectiveAccessDto>(`/users/${id}/effective-access`);
}
