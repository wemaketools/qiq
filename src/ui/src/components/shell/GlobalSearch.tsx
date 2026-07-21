import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../common/Icon';
import type { IconName } from '../common/Icon';
import { useAppSelector } from '../../app/hooks';
import { selectHasAnyPermission } from '../../app/slices/sessionSlice';
import { PermissionCodes } from '../../auth/permissions';
import { globalSearch, SEARCH_MIN_QUERY_LENGTH } from '../../features/search/searchApi';
import type { GlobalSearchDto } from '../../features/search/searchApi';

const SEARCH_DEBOUNCE_MS = 250;

/** One selectable dropdown row, flattened across all groups for arrow-key navigation. */
interface FlatResult {
  key: string;
  primary: string;
  secondary: string;
  /** Router path this row navigates to on select. */
  to: string;
}

interface ResultGroup {
  label: string;
  icon: IconName;
  items: FlatResult[];
}

/**
 * Resolves the router path a broker search hit navigates to, given the caller's broker permissions
 * (F-T038-04). The `/api/v1/search` endpoint is gated only on `leads.view` and returns brokers
 * tenant-wide (spec A-14), so a broker hit is the default result of any broker-name query for every
 * seeded role — but only broker admins may open `/settings/brokers` (its RouteGuard requires
 * `brokers.view`/`brokers.manage` under a Settings guard). Routing to it unconditionally funnelled
 * Relationship Manager / Underwriter / Sales Operations / Executive Viewer (leads.view holders
 * without broker admin) straight into the Forbidden page, violating the AC-083/T-044 principle that
 * legitimate roles are never dead-ended into Forbidden by normal navigation. So:
 *  - broker admins (`brokers.view`/`brokers.manage`) -> `/settings/brokers?focus={id}` (unchanged);
 *  - otherwise Broker Performance viewers (`dashboards.view_broker_performance`, the permission
 *    gating the `/brokers` dashboard from T-034) -> `/brokers`. That page does not consume a `focus`
 *    param today, so no fabricated param is appended (flagged in F-T038-04's resolution note);
 *  - otherwise the caller can open no broker destination, so the hit is suppressed (`null`) and the
 *    broker group is omitted entirely, mirroring AC-052's "breadth permissions constrain visible
 *    items" rather than showing an unopenable result.
 */
type BrokerRouteResolver = (brokerId: number) => string | null;

/**
 * Builds the ordered, grouped result list from the backend response (spec FR-53, A-14, T-038).
 * Group order Parties -> Leads -> Quotes -> Brokers matches the verification (V-052). Routing per
 * `T-038` implementation_details: lead -> `/leads/{id}`, quote -> `/leads/{leadId}?highlightQuote={id}`
 * (reusing the T-037 `highlightQuote` param `LeadDetailPage` already reads), party -> `/parties/{id}`,
 * broker -> permission-aware destination via `resolveBrokerRoute` (see above; hits the caller cannot
 * open are dropped).
 */
function toGroups(results: GlobalSearchDto, resolveBrokerRoute: BrokerRouteResolver): ResultGroup[] {
  const brokerItems: FlatResult[] = results.brokers.reduce<FlatResult[]>((items, b) => {
    const to = resolveBrokerRoute(b.id);
    if (to !== null) {
      items.push({ key: `broker-${b.id}`, primary: b.name, secondary: b.tier ?? 'Broker', to });
    }
    return items;
  }, []);

  const groups: ResultGroup[] = [
    {
      label: 'Clients',
      icon: 'parties',
      items: results.parties.map((p) => ({
        key: `party-${p.id}`,
        primary: p.name,
        secondary: p.type,
        to: `/parties/${p.id}`,
      })),
    },
    {
      label: 'Leads',
      icon: 'leads',
      items: results.leads.map((l) => ({
        key: `lead-${l.id}`,
        primary: l.ref,
        secondary: `${l.partyName} · ${l.status}`,
        to: `/leads/${l.id}`,
      })),
    },
    {
      label: 'Quotes',
      icon: 'reports',
      items: results.quotes.map((qt) => ({
        key: `quote-${qt.id}`,
        primary: qt.ref,
        secondary: `${qt.partyName} · ${qt.status}`,
        to: `/leads/${qt.leadId}?highlightQuote=${qt.id}`,
      })),
    },
    {
      label: 'Brokers',
      icon: 'brokers',
      items: brokerItems,
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/**
 * Top-bar global search (spec FR-53, A-14, AC-052, T-038), replacing the T-013 placeholder input.
 * 250ms client-side debounce, a 2-character minimum (mirroring the backend), a grouped dropdown with
 * per-entity headers, arrow-key navigation + Enter to select, Esc to close, and click-away close.
 * Built on the T-043 design-system layer (`.qiq-*` classes consuming `--qiq-*` tokens).
 */
function GlobalSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GlobalSearchDto | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  // Monotonic request id so a slow, stale response never overwrites a newer one.
  const requestIdRef = useRef(0);

  // Same effective permission set RouteGuard consumes (F-T038-04): decide each broker hit's
  // destination client-side so no role is routed to a screen its guard will reject.
  const canOpenBrokerAdmin = useAppSelector(
    selectHasAnyPermission([PermissionCodes.BrokersView, PermissionCodes.BrokersManage]),
  );
  const canViewBrokerPerformance = useAppSelector(
    selectHasAnyPermission([PermissionCodes.DashboardsViewBrokerPerformance]),
  );

  const resolveBrokerRoute = useCallback<BrokerRouteResolver>(
    (brokerId) => {
      if (canOpenBrokerAdmin) {
        return `/settings/brokers?focus=${brokerId}`;
      }
      if (canViewBrokerPerformance) {
        return '/brokers';
      }
      return null;
    },
    [canOpenBrokerAdmin, canViewBrokerPerformance],
  );

  const groups = useMemo(
    () => (results ? toGroups(results, resolveBrokerRoute) : []),
    [results, resolveBrokerRoute],
  );
  const flatItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const trimmed = query.trim();
  const meetsMinLength = trimmed.length >= SEARCH_MIN_QUERY_LENGTH;

  const closeDropdown = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  // Debounced fetch: fires only when the trimmed query meets the minimum length.
  useEffect(() => {
    if (!meetsMinLength) {
      setResults(null);
      setLoading(false);
      return;
    }

    const handle = window.setTimeout(() => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      globalSearch(trimmed)
        .then((response) => {
          if (requestId !== requestIdRef.current) {
            return;
          }
          setResults(response);
          setOpen(true);
          setActiveIndex(-1);
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) {
            return;
          }
          setResults({ leads: [], quotes: [], parties: [], brokers: [] });
          setOpen(true);
        })
        .finally(() => {
          if (requestId === requestIdRef.current) {
            setLoading(false);
          }
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(handle);
  }, [trimmed, meetsMinLength]);

  // Click-away closes the dropdown.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        closeDropdown();
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, closeDropdown]);

  const selectItem = useCallback(
    (item: FlatResult) => {
      closeDropdown();
      setQuery('');
      setResults(null);
      navigate(item.to);
    },
    [closeDropdown, navigate],
  );

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      closeDropdown();
      return;
    }

    if (event.key === 'ArrowDown') {
      if (flatItems.length === 0) {
        return;
      }
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => (current + 1) % flatItems.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      if (flatItems.length === 0) {
        return;
      }
      event.preventDefault();
      setActiveIndex((current) => (current <= 0 ? flatItems.length - 1 : current - 1));
      return;
    }

    if (event.key === 'Enter') {
      const activeItem = activeIndex >= 0 ? flatItems[activeIndex] : undefined;
      if (activeItem) {
        event.preventDefault();
        selectItem(activeItem);
      }
    }
  }

  const showDropdown = open && meetsMinLength;
  const showEmpty = showDropdown && !loading && flatItems.length === 0;

  // Running index across groups so arrow-key `activeIndex` maps to the right rendered row.
  let renderIndex = -1;

  return (
    <div className="qiq-searchbox qiq-global-search" ref={containerRef}>
      <Icon name="search" size={16} />
      <input
        type="search"
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls="qiq-global-search-listbox"
        aria-autocomplete="list"
        data-testid="global-search-input"
        aria-label="Search leads, quotes, clients, brokers"
        placeholder="Search leads, quotes, clients, brokers…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => {
          if (meetsMinLength && flatItems.length > 0) {
            setOpen(true);
          }
        }}
        onKeyDown={onKeyDown}
      />

      {showDropdown && (
        <div
          className="qiq-search-results"
          id="qiq-global-search-listbox"
          role="listbox"
          data-testid="search-results"
        >
          {showEmpty ? (
            <p className="qiq-search-empty" data-testid="search-empty">
              No matches for “{trimmed}”
            </p>
          ) : (
            groups.map((group) => (
              <div className="qiq-search-group" key={group.label}>
                <p className="qiq-search-group-header" data-testid="search-group-header">
                  <Icon name={group.icon} size={13} />
                  {group.label}
                </p>
                <ul className="qiq-search-group-list">
                  {group.items.map((item) => {
                    renderIndex += 1;
                    const isActive = renderIndex === activeIndex;
                    return (
                      <li key={item.key}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={isActive}
                          className={isActive ? 'qiq-search-result is-active' : 'qiq-search-result'}
                          data-testid="search-result-item"
                          // Prevent the input's blur from racing the click-away handler before select.
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => selectItem(item)}
                        >
                          <span className="qiq-search-result-primary">{item.primary}</span>
                          <span className="qiq-search-result-secondary">{item.secondary}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default GlobalSearch;
