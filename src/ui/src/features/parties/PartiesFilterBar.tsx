import { useEffect, useState } from 'react';
import type { PartiesFilters, ReferenceOption } from './partiesFilters';

const SEARCH_DEBOUNCE_MS = 250;

interface PartiesFilterBarProps {
  filters: PartiesFilters;
  onChange: (filters: PartiesFilters) => void;
  onClear: () => void;
  /** `null` = the caller could not load this option set (permission gap) and the control degrades to disabled. */
  partyTypeOptions: ReferenceOption[] | null;
  segmentOptions: ReferenceOption[] | null;
  industryOptions: ReferenceOption[] | null;
  regionOptions: ReferenceOption[] | null;
}

/**
 * Parties list filter row (spec FR-26, PRD 12.9): party type, segment, industry, region, a
 * strategic-only toggle, plus a 250ms debounced type-ahead search (`ListPartiesQuery.Search`, backed
 * server-side by pg_trgm similarity + ILIKE — see `PartyStore.ListAsync`'s doc comment).
 */
function PartiesFilterBar({
  filters,
  onChange,
  onClear,
  partyTypeOptions,
  segmentOptions,
  industryOptions,
  regionOptions,
}: PartiesFilterBarProps) {
  const [searchText, setSearchText] = useState(filters.search);

  useEffect(() => {
    setSearchText(filters.search);
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

  function updateSingle<K extends keyof PartiesFilters>(key: K, value: PartiesFilters[K]): void {
    onChange({ ...filters, [key]: value });
  }

  function parseSelectId(value: string): number | null {
    return value === '' ? null : Number(value);
  }

  return (
    <div data-testid="parties-filter-bar" className="qiq-filterbar">
      <div className="qiq-field">
        <label htmlFor="parties-filter-type">Party type</label>
        <select
          id="parties-filter-type"
          data-testid="party-type-filter"
          disabled={partyTypeOptions === null}
          value={filters.partyTypeId ?? ''}
          onChange={(event) => updateSingle('partyTypeId', parseSelectId(event.target.value))}
        >
          <option value="">All types</option>
          {(partyTypeOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="qiq-field">
        <label htmlFor="parties-filter-segment">Segment</label>
        <select
          id="parties-filter-segment"
          data-testid="segment-filter"
          disabled={segmentOptions === null}
          value={filters.segmentId ?? ''}
          onChange={(event) => updateSingle('segmentId', parseSelectId(event.target.value))}
        >
          <option value="">All segments</option>
          {(segmentOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="qiq-field">
        <label htmlFor="parties-filter-industry">Industry</label>
        <select
          id="parties-filter-industry"
          data-testid="industry-filter"
          disabled={industryOptions === null}
          value={filters.industryId ?? ''}
          onChange={(event) => updateSingle('industryId', parseSelectId(event.target.value))}
        >
          <option value="">All industries</option>
          {(industryOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="qiq-field">
        <label htmlFor="parties-filter-region">Region</label>
        <select
          id="parties-filter-region"
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
        <label htmlFor="parties-filter-search">Search</label>
        <input
          id="parties-filter-search"
          data-testid="parties-search-input"
          type="text"
          placeholder="Party name"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
        />
      </div>

      <div className="qiq-field" style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center' }}>
        <label htmlFor="parties-strategic-toggle" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--qiq-space-2)' }}>
          <input
            id="parties-strategic-toggle"
            data-testid="strategic-only-toggle"
            type="checkbox"
            checked={filters.strategicOnly}
            onChange={(event) => updateSingle('strategicOnly', event.target.checked)}
          />
          Strategic only
        </label>
      </div>

      <button type="button" className="qiq-btn" data-testid="clear-filters-button" onClick={onClear}>
        Clear filters
      </button>
    </div>
  );
}

export default PartiesFilterBar;
