import { useEffect, useState } from 'react';
import type { LeadsFilters, ReferenceOption } from './leadsFilters';

const SEARCH_DEBOUNCE_MS = 250;

interface LeadsFilterBarProps {
  filters: LeadsFilters;
  onChange: (filters: LeadsFilters) => void;
  onClear: () => void;
  /** `null` = the caller could not load this option set (permission gap) and the control degrades to disabled. */
  statusOptions: ReferenceOption[] | null;
  ownerOptions: ReferenceOption[] | null;
  brokerOptions: ReferenceOption[] | null;
  productLineOptions: ReferenceOption[] | null;
  regionOptions: ReferenceOption[] | null;
  channelOptions: ReferenceOption[] | null;
  /** True when the caller lacks `leads.view_all` (spec A-17): My-leads is forced on and the toggle is disabled. */
  myLeadsForced: boolean;
}

/**
 * Leads list filter row (spec FR-43): status dropdown (all-or-one over the multi-capable statusIds
 * URL/API param), owner, broker, product line, region, request channel, date-received range, and the
 * My-leads breadth toggle (A-17), plus a 250ms debounced free-text search. Every reference-option prop degrades to a disabled control (rather
 * than crashing) when its source endpoint 403s for the caller — see `LeadsListPage`'s loader.
 */
function LeadsFilterBar({
  filters,
  onChange,
  onClear,
  statusOptions,
  ownerOptions,
  brokerOptions,
  productLineOptions,
  regionOptions,
  channelOptions,
  myLeadsForced,
}: LeadsFilterBarProps) {
  const [searchText, setSearchText] = useState(filters.search);

  useEffect(() => {
    setSearchText(filters.search);
    // Only re-sync from external filter resets (e.g. Clear filters); the effect below owns
    // debouncing on user keystrokes.
  }, [filters.search]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (searchText !== filters.search) {
        onChange({ ...filters, search: searchText });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  function updateSingle<K extends keyof LeadsFilters>(key: K, value: LeadsFilters[K]): void {
    onChange({ ...filters, [key]: value });
  }

  function parseSelectId(value: string): number | null {
    return value === '' ? null : Number(value);
  }

  return (
    <div data-testid="leads-filter-bar" className="qiq-filterbar">
      <div className="qiq-field">
        <label htmlFor="leads-filter-status">Status</label>
        {/* Single-height dropdown driving the (still multi-capable) statusIds array: the URL/API keep
            accepting several ids (dashboard drill links), the UI picks all-or-one. When a drill link
            carries several ids, the select shows "All statuses" without discarding them. */}
        <select
          id="leads-filter-status"
          data-testid="status-filter"
          disabled={statusOptions === null}
          value={filters.statusIds.length === 1 ? String(filters.statusIds[0]) : ''}
          onChange={(event) =>
            updateSingle('statusIds', event.target.value === '' ? [] : [Number(event.target.value)])
          }
        >
          <option value="">All statuses</option>
          {(statusOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="qiq-field">
        <label htmlFor="leads-filter-owner">Owner</label>
        <select
          id="leads-filter-owner"
          data-testid="owner-filter"
          disabled={ownerOptions === null}
          value={filters.ownerUserId ?? ''}
          onChange={(event) => updateSingle('ownerUserId', parseSelectId(event.target.value))}
        >
          <option value="">All owners</option>
          {(ownerOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="qiq-field">
        <label htmlFor="leads-filter-broker">Broker</label>
        <select
          id="leads-filter-broker"
          data-testid="broker-filter"
          disabled={brokerOptions === null}
          value={filters.brokerId ?? ''}
          onChange={(event) => updateSingle('brokerId', parseSelectId(event.target.value))}
        >
          <option value="">All brokers</option>
          {(brokerOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="qiq-field">
        <label htmlFor="leads-filter-product-line">Product line</label>
        <select
          id="leads-filter-product-line"
          data-testid="product-line-filter"
          disabled={productLineOptions === null}
          value={filters.productLineId ?? ''}
          onChange={(event) => updateSingle('productLineId', parseSelectId(event.target.value))}
        >
          <option value="">All product lines</option>
          {(productLineOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="qiq-field">
        <label htmlFor="leads-filter-region">Region</label>
        <select
          id="leads-filter-region"
          data-testid="region-filter"
          disabled={regionOptions === null}
          value={filters.regionId ?? ''}
          onChange={(event) => updateSingle('regionId', parseSelectId(event.target.value))}
        >
          <option value="">All regions</option>
          {(regionOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="qiq-field">
        <label htmlFor="leads-filter-channel">Request channel</label>
        <select
          id="leads-filter-channel"
          data-testid="channel-filter"
          disabled={channelOptions === null}
          value={filters.requestChannelId ?? ''}
          onChange={(event) => updateSingle('requestChannelId', parseSelectId(event.target.value))}
        >
          <option value="">All channels</option>
          {(channelOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="qiq-field">
        <label htmlFor="leads-filter-date-from">Date received from</label>
        <input
          id="leads-filter-date-from"
          data-testid="date-received-from"
          type="date"
          value={filters.dateReceivedFrom ?? ''}
          onChange={(event) => updateSingle('dateReceivedFrom', event.target.value || null)}
        />
      </div>

      <div className="qiq-field">
        <label htmlFor="leads-filter-date-to">Date received to</label>
        <input
          id="leads-filter-date-to"
          data-testid="date-received-to"
          type="date"
          value={filters.dateReceivedTo ?? ''}
          onChange={(event) => updateSingle('dateReceivedTo', event.target.value || null)}
        />
      </div>

      <div className="qiq-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 'var(--qiq-space-2)' }}>
        <label htmlFor="leads-filter-search">Search</label>
        <input
          id="leads-filter-search"
          data-testid="leads-search-input"
          type="text"
          placeholder="Lead ref, party, or broker"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
        />
      </div>

      <div className="qiq-field" style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center' }}>
        <label htmlFor="leads-my-leads-toggle" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--qiq-space-2)' }}>
          <input
            id="leads-my-leads-toggle"
            data-testid="my-leads-toggle"
            type="checkbox"
            checked={filters.myLeads || myLeadsForced}
            disabled={myLeadsForced}
            onChange={(event) => updateSingle('myLeads', event.target.checked)}
          />
          My leads
        </label>
      </div>

      <button type="button" className="qiq-btn" data-testid="clear-filters-button" onClick={onClear}>
        Clear filters
      </button>
    </div>
  );
}

export default LeadsFilterBar;
