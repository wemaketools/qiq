import { apiGet, apiPost, apiPut } from '../../api/client';

/**
 * User group administration backend contract (src/api/QuoteIQ.Api/Endpoints/GroupEndpoints.cs,
 * src/api/QuoteIQ.Application/Features/Groups/*). Tenant-scoped like `usersApi.ts`; see that
 * module's header for the fetch-wrapper-vs-RTK-Query deviation note. Member add/remove and
 * roles/permissions replacement are action-style `POST` routes on the backend (never `DELETE`),
 * mirrored here as-is.
 */
export interface GroupDto {
  id: number;
  tenantId: number | null;
  name: string;
  isActive: boolean;
}

export interface GroupDetailDto {
  id: number;
  tenantId: number | null;
  name: string;
  isActive: boolean;
  memberUserIds: number[];
  roleIds: number[];
  permissionCodes: string[];
}

export function listGroups(): Promise<GroupDto[]> {
  return apiGet<GroupDto[]>('/groups');
}

export function getGroup(id: number): Promise<GroupDetailDto> {
  return apiGet<GroupDetailDto>(`/groups/${id}`);
}

export function createGroup(name: string): Promise<GroupDto> {
  return apiPost<GroupDto>('/groups', { name });
}

export function updateGroup(id: number, name: string): Promise<GroupDto> {
  return apiPut<GroupDto>(`/groups/${id}`, { name });
}

export function disableGroup(id: number): Promise<void> {
  return apiPost<void>(`/groups/${id}/disable`);
}

export function addGroupMember(id: number, userId: number): Promise<void> {
  return apiPost<void>(`/groups/${id}/members`, { userId });
}

export function removeGroupMember(id: number, userId: number): Promise<void> {
  return apiPost<void>(`/groups/${id}/members/${userId}/remove`);
}

export function setGroupRoles(id: number, roleIds: number[]): Promise<void> {
  return apiPost<void>(`/groups/${id}/roles`, { roleIds });
}

export function setGroupPermissions(id: number, permissionCodes: string[]): Promise<void> {
  return apiPost<void>(`/groups/${id}/permissions`, { permissionCodes });
}
