import { apiGet } from './client';

/**
 * `GET /api/v1/settings/business-rules` response shape (src/api/.../BusinessRules/BusinessRuleEndpoints.cs
 * `BusinessRulesDto`). Tenant-scoped; requires `business_rules.view`. Only the display-currency
 * fields are consumed by the shell (spec A-3, AC-074); the rest of the DTO is settings-screen
 * concern (T-016).
 */
export interface BusinessRulesDto {
  currencyCode: string;
  currencySymbol: string;
}

export function fetchBusinessRules(): Promise<BusinessRulesDto> {
  return apiGet<BusinessRulesDto>('/settings/business-rules');
}
