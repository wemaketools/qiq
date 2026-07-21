import type { DashboardFiltersState } from '../../app/slices/dashboardFiltersSlice';

export interface DashboardReferenceOption {
  id: number;
  name: string;
}

export type FilterBarVariant = 'default' | 'rmPerformance';

interface DatePreset {
  key: string;
  label: string;
  range: () => { from: string; to: string };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

const DATE_PRESETS: DatePreset[] = [
  {
    key: 'this-month',
    label: 'This month',
    range: () => {
      const now = new Date();
      return { from: isoDate(startOfMonth(now)), to: isoDate(endOfMonth(now)) };
    },
  },
  {
    key: 'last-month',
    label: 'Last month',
    range: () => {
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return { from: isoDate(startOfMonth(lastMonth)), to: isoDate(endOfMonth(lastMonth)) };
    },
  },
  {
    key: 'this-quarter',
    label: 'This quarter',
    range: () => {
      const now = new Date();
      const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
      const from = new Date(now.getFullYear(), quarterStartMonth, 1);
      const to = new Date(now.getFullYear(), quarterStartMonth + 3, 0);
      return { from: isoDate(from), to: isoDate(to) };
    },
  },
];

interface FilterBarProps {
  filters: DashboardFiltersState;
  onChange: (filters: DashboardFiltersState) => void;
  onClear: () => void;
  /** `null` = the caller could not load this option set (permission gap) and the control degrades to disabled. */
  productLineOptions: DashboardReferenceOption[] | null;
  brokerOptions: DashboardReferenceOption[] | null;
  rmOptions: DashboardReferenceOption[] | null;
  regionOptions: DashboardReferenceOption[] | null;
  /** The RM-variant "Broker Type" option set (broker-type reference items); only used when `variant === 'rmPerformance'`. */
  brokerTypeOptions?: DashboardReferenceOption[] | null;
  /** RM Performance's filter-bar variant (spec §10.1): relabels RM -> "RM/Team" (binds `teamOrRmId`) and Broker -> "Broker Type" (binds `brokerTypeId`). */
  variant?: FilterBarVariant;
}

/**
 * The shared dashboard filter bar (spec FR-54, AC-053, T-031): date range with presets, dropdowns
 * defaulting to "All" (empty selection = null = no filter), and Clear filters. State itself lives in
 * `dashboardFiltersSlice` (persisted across dashboard routes, spec A-16) — this component is a
 * controlled view over that state.
 */
function FilterBar({ filters, onChange, onClear, productLineOptions, brokerOptions, rmOptions, regionOptions, brokerTypeOptions = null, variant = 'default' }: FilterBarProps) {
  function updateSingle<K extends keyof DashboardFiltersState>(key: K, value: DashboardFiltersState[K]): void {
    onChange({ ...filters, [key]: value });
  }

  function parseSelectId(value: string): number | null {
    return value === '' ? null : Number(value);
  }

  function applyPreset(preset: DatePreset): void {
    const { from, to } = preset.range();
    onChange({ ...filters, dateFrom: from, dateTo: to });
  }

  const isRmVariant = variant === 'rmPerformance';
  const rmLabel = isRmVariant ? 'RM/Team' : 'RM';
  const brokerLabel = isRmVariant ? 'Broker Type' : 'Broker';

  // The RM variant binds its two variant selects to the dedicated filter fields (teamOrRmId / brokerTypeId,
  // honored by GET /dashboards/rm-performance); every other dashboard uses the plain RM / Broker fields.
  const rmField: keyof DashboardFiltersState = isRmVariant ? 'teamOrRmId' : 'rmUserId';
  const brokerField: keyof DashboardFiltersState = isRmVariant ? 'brokerTypeId' : 'brokerId';
  const brokerSelectOptions = isRmVariant ? brokerTypeOptions : brokerOptions;

  return (
    <div data-testid={isRmVariant ? 'filter-bar-rm-variant' : 'filter-bar'} className="qiq-filterbar">
      <div style={{ display: 'flex', gap: 'var(--qiq-space-1)', alignSelf: 'flex-end' }}>
        {DATE_PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            className="qiq-btn qiq-btn--sm"
            data-testid={`date-preset-${preset.key}`}
            onClick={() => applyPreset(preset)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="qiq-field">
        <label htmlFor="filter-date-from">Date from</label>
        <input
          id="filter-date-from"
          data-testid="filter-date-from"
          type="date"
          value={filters.dateFrom ?? ''}
          onChange={(event) => updateSingle('dateFrom', event.target.value || null)}
        />
      </div>

      <div className="qiq-field">
        <label htmlFor="filter-date-to">Date to</label>
        <input
          id="filter-date-to"
          data-testid="filter-date-to"
          type="date"
          value={filters.dateTo ?? ''}
          onChange={(event) => updateSingle('dateTo', event.target.value || null)}
        />
      </div>

      <div className="qiq-field">
        <label htmlFor="filter-product-line">Product line</label>
        <select
          id="filter-product-line"
          data-testid="filter-product-line"
          disabled={productLineOptions === null}
          value={filters.productLineId ?? ''}
          onChange={(event) => updateSingle('productLineId', parseSelectId(event.target.value))}
        >
          <option value="">All</option>
          {(productLineOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="qiq-field">
        <label htmlFor="filter-broker">{brokerLabel}</label>
        <select
          id="filter-broker"
          data-testid="filter-broker"
          disabled={brokerSelectOptions === null}
          value={filters[brokerField] ?? ''}
          onChange={(event) => updateSingle(brokerField, parseSelectId(event.target.value))}
        >
          <option value="">All</option>
          {(brokerSelectOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="qiq-field">
        <label htmlFor="filter-rm">{rmLabel}</label>
        <select
          id="filter-rm"
          data-testid="filter-rm"
          disabled={rmOptions === null}
          value={filters[rmField] ?? ''}
          onChange={(event) => updateSingle(rmField, parseSelectId(event.target.value))}
        >
          <option value="">All</option>
          {(rmOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <div className="qiq-field">
        <label htmlFor="filter-region">Region</label>
        <select
          id="filter-region"
          data-testid="filter-region"
          disabled={regionOptions === null}
          value={filters.regionId ?? ''}
          onChange={(event) => updateSingle('regionId', parseSelectId(event.target.value))}
        >
          <option value="">All</option>
          {(regionOptions ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <button type="button" className="qiq-btn" data-testid="clear-filters-button" onClick={onClear}>
        Clear filters
      </button>
    </div>
  );
}

export default FilterBar;
