import { apiGet, apiPut } from './client';

/**
 * `GET /api/v1/me` response shape (src/api/QuoteIQ.Application/Features/Me/GetMe/GetMeQuery.cs
 * `GetMeResult`/`MembershipDto`, System.Text.Json camelCase defaults). Global route — no
 * `X-Tenant-Id` required (see `client.ts` tenant-exempt prefixes).
 */
export interface MeMembership {
  tenantId: number;
  tenantName: string;
  /** Tenant display currency (spec A-3, AC-074): present for every membership, not gated by a Settings permission. */
  currencyCode: string;
  currencySymbol: string;
  effectivePermissions: string[];
}

export interface MeResponse {
  userId: number;
  email: string;
  firstName: string;
  lastName: string;
  lastTenantId: number | null;
  themePreference: string | null;
  memberships: MeMembership[];
  /** Tenant-less global grants (T-045) — lets zero-membership Internal users drive the shell. */
  globalPermissions: string[];
}

export interface SetMePreferencesRequest {
  lastTenantId?: number | null;
  themePreference?: string | null;
}

export function fetchMe(): Promise<MeResponse> {
  return apiGet<MeResponse>('/me');
}

export function setMePreferences(request: SetMePreferencesRequest): Promise<void> {
  return apiPut<void>('/me/preferences', request);
}
