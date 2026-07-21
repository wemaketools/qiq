import { NavLink } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectHasAnyPermission } from '../../app/slices/sessionSlice';
import { selectAlertsBadgeCount } from '../../app/slices/alertsBadgeSlice';
import { selectActiveTenant } from '../../app/slices/sessionSlice';
import Icon from '../common/Icon';
import { STANDARD_NAV_ITEMS, ADMIN_NAV_ITEMS } from './navConfig';
import type { NavItem } from './navConfig';

function NavItemLink({ item }: { item: NavItem }) {
  const visible = useAppSelector(selectHasAnyPermission(item.permissions ?? []));
  const badgeCount = useAppSelector(selectAlertsBadgeCount);

  // Illegal/unpermitted navigation is hidden entirely, never rendered disabled (UI Standards §8,
  // AC-016): nothing in the DOM for this item when the user lacks every listed permission.
  if (item.permissions && !visible) {
    return null;
  }

  return (
    <li>
      <NavLink
        to={item.path}
        data-testid={item.testId}
        className={({ isActive }) => (isActive ? 'qiq-nav-item qiq-nav-item--active' : 'qiq-nav-item')}
      >
        <Icon name={item.icon} size={19} />
        <span>{item.label}</span>
        {item.showAlertsBadge && badgeCount > 0 && (
          <span className="qiq-nav-badge" data-testid="nav-alerts-badge">
            {badgeCount}
          </span>
        )}
      </NavLink>
    </li>
  );
}

/**
 * Fixed left sidebar (spec FR-52, PRD 12.1/12.2, T-043 restyle per UI Standards §3.1–3.2): tenant
 * brand line, QuoteIQ wordmark, standard nav sections, then a separator, then permission-gated
 * administrative sections (Settings, User Manager, Tenant Manager). Each item independently hides
 * itself when the active tenant's effective permissions (delivered by `GET /me`) don't include any
 * of its required codes. Active item renders as an accent pill (§3.2).
 */
function Sidebar() {
  const activeTenant = useAppSelector(selectActiveTenant);

  return (
    <nav
      data-testid="sidebar-nav"
      aria-label="Primary"
      // The nav must scroll WITHIN its own bounded region: with `flex: 1; min-height: 0` the nav box
      // is shrunk to the space left by the pinned TenantSwitcher/UserCard below it, and its content
      // (brand + every permitted section) can be taller than that box for a full-nav persona at
      // 1280x720. Without `overflow-y: auto` the overflow spilled past the box and the switcher (a
      // later sibling) painted over — and intercepted clicks on — the lowest nav links (Tenant/User
      // Manager). Clipping+scrolling here keeps every link reachable and un-overlapped for any nav
      // length (T-052, F-043-4).
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' }}
    >
      <div data-testid="sidebar-brand" className="qiq-brand">
        {activeTenant && <div className="qiq-brand-tenant">{activeTenant.tenantName}</div>}
        <div className="qiq-brand-name">
          Quote<span className="qiq-brand-iq">IQ</span>
        </div>
        <div className="qiq-brand-sub">Quotation Intelligence</div>
      </div>

      <ul className="qiq-nav">
        {STANDARD_NAV_ITEMS.map((item) => (
          <NavItemLink key={item.path} item={item} />
        ))}
      </ul>

      <hr data-testid="sidebar-separator" className="qiq-sidebar-sep" />

      <ul className="qiq-nav">
        {ADMIN_NAV_ITEMS.map((item) => (
          <NavItemLink key={item.path} item={item} />
        ))}
      </ul>
    </nav>
  );
}

export default Sidebar;
