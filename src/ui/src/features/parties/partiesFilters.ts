/**
 * Parties list filter-state types/defaults (spec FR-26, PRD 12.9, T-025), split out of
 * `PartiesFilterBar.tsx` into a non-component module — same `react-refresh/only-export-components`
 * rationale as `leadsFilters.ts`.
 */

export interface ReferenceOption {
  id: number;
  name: string;
}

export interface PartiesFilters {
  partyTypeId: number | null;
  segmentId: number | null;
  industryId: number | null;
  regionId: number | null;
  strategicOnly: boolean;
  search: string;
}

export const EMPTY_PARTIES_FILTERS: PartiesFilters = {
  partyTypeId: null,
  segmentId: null,
  industryId: null,
  regionId: null,
  strategicOnly: false,
  search: '',
};
