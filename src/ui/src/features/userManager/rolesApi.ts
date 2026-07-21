import { apiGet, apiPost, apiPut } from '../../api/client';

/**
 * Role administration backend contract (src/api/QuoteIQ.Api/Endpoints/RoleEndpoints.cs,
 * src/api/QuoteIQ.Application/Features/Roles/*). Tenant-scoped like `usersApi.ts`; see that
 * module's header for the fetch-wrapper-vs-RTK-Query deviation note.
 */
export interface RoleDto {
  id: number;
  tenantId: number | null;
  name: string;
  isActive: boolean;
  permissionCodes: string[];
}

export interface RoleWritePayload {
  name: string;
  permissionCodes: string[];
}

export interface RoleUsageUserDto {
  userId: number;
  email: string;
  tenantId: number | null;
}

export interface RoleUsageGroupDto {
  groupId: number;
  name: string;
  tenantId: number | null;
}

export interface RoleUsageDto {
  users: RoleUsageUserDto[];
  groups: RoleUsageGroupDto[];
}

export function listRoles(): Promise<RoleDto[]> {
  return apiGet<RoleDto[]>('/roles');
}

export function getRole(id: number): Promise<RoleDto> {
  return apiGet<RoleDto>(`/roles/${id}`);
}

export function createRole(payload: RoleWritePayload): Promise<RoleDto> {
  return apiPost<RoleDto>('/roles', payload);
}

export function updateRole(id: number, payload: RoleWritePayload): Promise<RoleDto> {
  return apiPut<RoleDto>(`/roles/${id}`, payload);
}

/** `force=true` disables despite in-use rows returned by {@link getRoleUsage} (server still audits/validates). */
export function disableRole(id: number, force: boolean): Promise<void> {
  return apiPost<void>(`/roles/${id}/disable`, force ? { force: true } : undefined);
}

export function getRoleUsage(id: number): Promise<RoleUsageDto> {
  return apiGet<RoleUsageDto>(`/roles/${id}/usage`);
}
