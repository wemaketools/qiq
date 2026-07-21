import type { ReactNode } from 'react';
import { useAppSelector } from './hooks';
import { selectHasAnyPermission } from './slices/sessionSlice';
import ForbiddenPage from '../pages/ForbiddenPage';

interface RouteGuardProps {
  /** Any one of these permission codes grants access to the wrapped route. */
  permissions: string[];
  children: ReactNode;
}

/**
 * Route-level permission guard (spec FR-17, AC-016): renders {@link ForbiddenPage} in place — not a
 * redirect — when the active tenant's effective permissions include none of `permissions`. Mirrors
 * (but never replaces) the server-side `RequirePermission` check every gated API endpoint enforces;
 * this is a UX affordance only, per the project's "treat the client as hostile" stance.
 */
function RouteGuard({ permissions, children }: RouteGuardProps) {
  const allowed = useAppSelector(selectHasAnyPermission(permissions));
  return allowed ? children : <ForbiddenPage />;
}

export default RouteGuard;
