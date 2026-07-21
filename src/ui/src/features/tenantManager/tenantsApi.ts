import { apiGet, apiPost, apiPut } from '../../api/client';

/**
 * Tenant Manager backend contract (src/api/QuoteIQ.Api/Endpoints/TenantEndpoints.cs,
 * src/api/QuoteIQ.Application/Features/Tenants/TenantDto.cs, System.Text.Json camelCase
 * defaults). Global routes — no `X-Tenant-Id` (see `client.ts` tenant-exempt prefixes) — each
 * gated server-side by a `PermissionCatalog.Tenants` permission code (spec FR-06/FR-07, AC-006).
 * This module is the single place tenant admin screens call the API from, per the project's
 * "API calls go through the existing client layer" convention.
 */
export type TenantStatus = 'active' | 'removed';

export interface TenantDto {
  id: number;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  status: TenantStatus;
  removedAt: string | null;
}

/** Body shape for both `POST /tenants` and `PUT /tenants/{id}` (name + contact fields only, FR-06). */
export interface TenantWritePayload {
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

export interface CreateTenantResult {
  tenantId: number;
  name: string;
  status: TenantStatus;
}

export function listTenants(includeRemoved: boolean): Promise<TenantDto[]> {
  return apiGet<TenantDto[]>(`/tenants${includeRemoved ? '?includeRemoved=true' : ''}`);
}

export function getTenant(id: number): Promise<TenantDto> {
  return apiGet<TenantDto>(`/tenants/${id}`);
}

export function createTenant(payload: TenantWritePayload): Promise<CreateTenantResult> {
  return apiPost<CreateTenantResult>('/tenants', payload);
}

export function updateTenant(id: number, payload: TenantWritePayload): Promise<TenantDto> {
  return apiPut<TenantDto>(`/tenants/${id}`, payload);
}

export function removeTenant(id: number): Promise<void> {
  return apiPost<void>(`/tenants/${id}/remove`);
}

export function restoreTenant(id: number): Promise<void> {
  return apiPost<void>(`/tenants/${id}/restore`);
}
