import { useNavigate } from 'react-router-dom';

/**
 * Navigates to the generic drill-through screen for a given widget key (spec FR-54/AC-053: "every
 * KPI/chart/row drills to underlying items"). The target `DrillListPage` reads the active dashboard
 * filters straight from `dashboardFiltersSlice` (already persisted across dashboard routes, A-16) --
 * this hook only needs to carry the widget key itself through the URL, not the filters.
 */
export default function useDrill() {
  const navigate = useNavigate();

  function navigateToDrill(widgetKey: string): void {
    navigate(`/dashboards/drill/${encodeURIComponent(widgetKey)}`);
  }

  return { navigateToDrill };
}
