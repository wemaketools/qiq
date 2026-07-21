import { useAppSelector } from '../../app/hooks';
import { selectActiveTenant, selectActiveTenantCurrency } from '../../app/slices/sessionSlice';

/**
 * Resolves the active tenant's display currency for the footer/inputs/cards (spec A-3, AC-074).
 * Sourced directly from the session (populated from `GET /me`, which carries `currencyCode` on
 * every membership) rather than `GET /settings/business-rules`, which requires `business_rules.view`
 * and would otherwise be wrong for any non-admin member — AC-074 requires the display currency to be
 * correct for *every* tenant member, not just Settings-capable admins. Re-renders automatically when
 * `activeTenantId` changes (tenant switch), since the selector reads the newly active membership.
 */
export function useTenantCurrency(): string {
  return useAppSelector(selectActiveTenantCurrency);
}

/**
 * The active tenant's display-currency symbol (spec A-3, AC-074, AC-028), for prefixing currency
 * inputs (`components/common/CurrencyInput.tsx`) — same session-sourced rationale as
 * `useTenantCurrency` above (`currencySymbol` is carried on every `GET /me` membership, so it
 * resolves correctly for every tenant member, not just `business_rules.view` holders).
 */
export function useTenantCurrencySymbol(): string {
  return useAppSelector((state) => selectActiveTenant(state)?.currencySymbol ?? 'BWP');
}
