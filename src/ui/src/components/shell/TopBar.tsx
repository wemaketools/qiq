import { useNavigate } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectHasPermission } from '../../app/slices/sessionSlice';
import { selectAlertsBadgeCount } from '../../app/slices/alertsBadgeSlice';
import { PermissionCodes } from '../../auth/permissions';
import Icon from '../common/Icon';
import ExportMenu from '../common/ExportMenu';
import GlobalSearch from './GlobalSearch';
import { useExportTarget } from '../../features/exports/ExportTargetContext';

interface TopBarProps {
  title: string;
}

/**
 * Top bar (spec FR-52, PRD 12.2, T-043 restyle): page title on the left; global search
 * (grouped type-ahead across leads/quotes/parties/brokers, FR-53/T-038 — see `GlobalSearch`),
 * notification bell icon-button (mirrors the
 * Alerts nav badge count, FR-63), help icon-button, Export (placeholder slot — per-screen behavior
 * lands with later tasks), and the primary `+ New Lead` action (the product is lead-first: the
 * global action always creates a Lead, PRD 12.2), gated on `leads.create`.
 */
function TopBar({ title }: TopBarProps) {
  const navigate = useNavigate();
  const badgeCount = useAppSelector(selectAlertsBadgeCount);
  const canCreateLead = useAppSelector(selectHasPermission(PermissionCodes.LeadsCreate));
  const exportTarget = useExportTarget();

  return (
    <header data-testid="topbar" className="qiq-topbar">
      <h1 data-testid="topbar-title">{title}</h1>
      <div className="qiq-topbar-spacer" />

      <GlobalSearch />

      <button type="button" className="qiq-icon-btn" data-testid="notification-bell" aria-label="Notifications">
        <Icon name="bell" size={18} />
        {badgeCount > 0 && (
          <span className="qiq-count" data-testid="notification-bell-badge">
            {badgeCount}
          </span>
        )}
      </button>
      <button type="button" className="qiq-icon-btn" data-testid="help-button" aria-label="Help">
        <Icon name="help" size={18} />
      </button>
      <div data-testid="export-slot">
        {exportTarget && (
          <ExportMenu
            testId="topbar-export-menu"
            fileNameBase={exportTarget.fileNameBase}
            buildPath={exportTarget.buildPath}
          />
        )}
      </div>
      {canCreateLead && (
        <button
          type="button"
          className="qiq-btn qiq-btn--primary"
          data-testid="new-lead-button"
          onClick={() => navigate('/leads/new')}
        >
          <Icon name="plus" size={16} />
          New Lead
        </button>
      )}
    </header>
  );
}

export default TopBar;
