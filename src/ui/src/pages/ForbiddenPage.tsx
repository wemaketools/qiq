import EmptyState from '../components/common/EmptyState';

/**
 * Route-level 403 (spec FR-17, AC-016, §10.2): rendered in place by `RouteGuard` when the active
 * tenant's effective permissions don't include a route's required code(s) — never a redirect, so
 * the URL (and the fact that access was denied) stays visible.
 */
function ForbiddenPage() {
  return (
    <div data-testid="forbidden-page">
      <EmptyState message="You don't have permission to view this page." />
    </div>
  );
}

export default ForbiddenPage;
