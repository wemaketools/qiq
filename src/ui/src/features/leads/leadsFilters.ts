/**
 * Leads list filter-state types/defaults (spec FR-43, T-027), split out of `LeadsFilterBar.tsx`
 * into a non-component module so the component file only exports the component itself (fixes the
 * `react-refresh/only-export-components` lint warning raised against the previous colocated
 * version — components and their non-component exports must live in separate modules for Fast
 * Refresh to reliably preserve state).
 */

export interface ReferenceOption {
  id: number;
  name: string;
}

export interface LeadsFilters {
  statusIds: number[];
  ownerUserId: number | null;
  brokerId: number | null;
  productLineId: number | null;
  regionId: number | null;
  requestChannelId: number | null;
  dateReceivedFrom: string | null;
  dateReceivedTo: string | null;
  myLeads: boolean;
  search: string;
}

export const EMPTY_LEADS_FILTERS: LeadsFilters = {
  statusIds: [],
  ownerUserId: null,
  brokerId: null,
  productLineId: null,
  regionId: null,
  requestChannelId: null,
  dateReceivedFrom: null,
  dateReceivedTo: null,
  myLeads: false,
  search: '',
};
