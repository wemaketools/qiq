import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { selectHasPermission, selectSession } from '../../app/slices/sessionSlice';
import { refreshAlertsBadge } from '../../app/slices/alertsBadgeSlice';
import { PermissionCodes } from '../../auth/permissions';

const POLL_INTERVAL_MS = 60_000;

/**
 * Keeps the shell's new-alert badge (Sidebar + TopBar bell) current (spec FR-63): polls
 * `GET /alerts/badge` on mount, every 60s, and whenever the window regains focus. Gated on
 * `alerts.view` — the badge endpoint is itself permission-gated (it reveals alert existence), so a
 * user without alerts access never polls it. Mounted once at the app-shell level.
 */
export function useAlertsBadgePolling(): void {
  const dispatch = useAppDispatch();
  const canViewAlerts = useAppSelector(selectHasPermission(PermissionCodes.AlertsView));
  // The badge is tenant-scoped (GET /alerts/badge carries X-Tenant-Id), so a tenant switch must
  // refetch immediately rather than showing the previous tenant's count until the next poll.
  const { activeTenantId } = useAppSelector(selectSession);

  useEffect(() => {
    if (!canViewAlerts) {
      return;
    }

    void dispatch(refreshAlertsBadge());

    const intervalId = window.setInterval(() => {
      void dispatch(refreshAlertsBadge());
    }, POLL_INTERVAL_MS);

    const onFocus = (): void => {
      void dispatch(refreshAlertsBadge());
    };
    window.addEventListener('focus', onFocus);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
    };
  }, [dispatch, canViewAlerts, activeTenantId]);
}
